"""
FastAPI server for PAROL6 Robot - HTTP/WebSocket bridge
"""

# Remove sys.path hacks - now using proper lib/ package structure
import sys
import os
from pathlib import Path

# Get project root (parent of api directory)
PROJECT_ROOT = Path(__file__).parent.parent


def safe_filename(filename: str) -> str:
    """
    Reduce a client-supplied filename to a bare, safe file name before it is
    ever joined onto a disk path.

    Uploaded mesh/URDF filenames (tool meshes, custom robot URDF + meshes)
    were previously written to disk as `some_dir / request.mesh_file` with no
    validation at all - a filename containing '..' or an absolute path would
    let a request write outside the intended meshes directory. This strips
    any directory components and rejects anything that doesn't look like a
    plausible mesh/URDF/model filename.
    """
    if not filename:
        raise HTTPException(status_code=400, detail="Missing filename")

    # Drop any directory component the client tried to sneak in, from either
    # a POSIX or Windows-style path.
    name = filename.replace("\\", "/").split("/")[-1]

    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9 ._-]{0,119}", name):
        raise HTTPException(status_code=400, detail=f"Invalid filename: {filename!r}")

    allowed_ext = {".stl", ".glb", ".gltf", ".urdf", ".dae", ".obj"}
    if Path(name).suffix.lower() not in allowed_ext:
        raise HTTPException(status_code=400, detail=f"Unsupported file type: {filename!r}")

    return name

# Apply numpy compatibility patch for numpy 2.0+
from api.utils import numpy_patch

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Query, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse, Response
from contextlib import asynccontextmanager
import asyncio
import logging
from typing import Optional, Dict, Any
import uuid
from datetime import datetime
import time
import yaml
import json
import xml.etree.ElementTree as ET
import shutil
import base64
import re
import math

# Import robot client (UDP client to commander) and models
from api import robot_client
from api.models import *
from api.websocket_manager import ConnectionManager
from api.utils.logging_handler import get_websocket_handler, setup_logging
from api.camera_manager import get_camera_manager

import numpy as np
import psutil
import subprocess

# Configuration file path
CONFIG_PATH = PROJECT_ROOT / "config.yaml"

# Load configuration from root directory
try:
    with open(CONFIG_PATH, "r") as f:
        config = yaml.safe_load(f)
except FileNotFoundError:
    logger.warning("config.yaml not found in root directory, using defaults")
    config = {
        'api': {
            'host': '0.0.0.0',
            'port': 8000,
            'cors_origins': ['http://localhost:3000', 'http://localhost:3001']
        },
        'logging': {
            'level': 'INFO',
            'buffer_size': 1000,
            'stream_to_websocket': True
        }
    }

# Set up logging with WebSocket handler
setup_logging(config.get('logging', {}), 'api')
logger = logging.getLogger('api')

# Global variables
manager = ConnectionManager()
robot_status_task: Optional[asyncio.Task] = None
system_status_task: Optional[asyncio.Task] = None
command_results: Dict[str, CommandAcknowledgment] = {}

# Connect WebSocket handler to manager
websocket_handler = get_websocket_handler()
websocket_handler.set_websocket_manager(manager)


# UDP Log Receiver Task - receives logs from commander via UDP and broadcasts to WebSocket clients
async def udp_log_receiver():
    """
    Background task to receive log messages from headless_commander via UDP
    and inject them into the WebSocket log stream
    """
    log_forward_port = config.get('server', {}).get('log_forward_port', 5003)

    logger.info(f"Starting UDP log receiver on port {log_forward_port}")

    # Create UDP socket
    import socket as sync_socket
    sock = sync_socket.socket(sync_socket.AF_INET, sync_socket.SOCK_DGRAM)
    sock.bind(('0.0.0.0', log_forward_port))
    sock.setblocking(False)

    loop = asyncio.get_event_loop()

    while True:
        try:
            # Non-blocking receive
            data = await loop.run_in_executor(None, sock.recvfrom, 8192)
            message, addr = data

            # Parse JSON log entry
            try:
                log_entry = json.loads(message.decode('utf-8'))

                # Inject into WebSocket handler's buffer
                websocket_handler.logs.append(log_entry)

                # Broadcast to WebSocket clients
                await manager.broadcast_json({
                    "type": "log",
                    "data": log_entry
                }, "logs")

            except json.JSONDecodeError:
                logger.warning(f"Received invalid JSON log from {addr}")

        except BlockingIOError:
            # No data available, wait a bit
            await asyncio.sleep(0.01)
        except Exception as e:
            logger.error(f"Error in UDP log receiver: {e}")
            await asyncio.sleep(0.1)


# Lifespan context manager for startup/shutdown
udp_log_task: Optional[asyncio.Task] = None

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage application lifecycle"""
    # Startup
    logger.info("Starting FastAPI server for PAROL6 Robot")

    # Start background task for robot status streaming
    global robot_status_task, system_status_task, udp_log_task
    robot_status_task = asyncio.create_task(stream_robot_status())
    system_status_task = asyncio.create_task(stream_system_status())

    # Start UDP log receiver if enabled
    if config.get('server', {}).get('log_forward_enabled', True):
        udp_log_task = asyncio.create_task(udp_log_receiver())

    yield

    # Shutdown
    logger.info("Shutting down FastAPI server")
    if robot_status_task:
        robot_status_task.cancel()
        try:
            await robot_status_task
        except asyncio.CancelledError:
            pass

    if system_status_task:
        system_status_task.cancel()
        try:
            await system_status_task
        except asyncio.CancelledError:
            pass

    if udp_log_task:
        udp_log_task.cancel()
        try:
            await udp_log_task
        except asyncio.CancelledError:
            pass


# Create FastAPI app
app = FastAPI(
    title="PAROL6 Robot API",
    description="""
RESTful API and WebSocket interface for PAROL6 robot control.

## Motion Types Guide

### Joint-Interpolated Motion (Move Pose)
- All joints move simultaneously to reach target
- Path may be curved in 3D space  
- Faster execution
- Best for: Pick-and-place, position-to-position moves

### Cartesian Motion (Move Cartesian)
- End-effector follows straight line path
- Joints coordinate to maintain linear trajectory
- May be slower than joint motion
- Best for: Welding, painting, insertion, drawing

### Smooth Motion Commands
- **Circle**: Circular paths in XY, XZ, or YZ planes
- **Arc**: Curved paths between two points
- **Spline**: Smooth curves through multiple waypoints
- **Helix**: Spiral/helical paths

## WebSocket Real-time Data
Connect to `/ws` for streaming robot telemetry at configurable rates (1-50Hz).
""",
    version="1.0.0",
    lifespan=lifespan
)

# Configure CORS - Allow frontend on port 3000 from any host
# This allows deployment without configuring specific IPs
# Regex matches: http://[any-host]:3000 and http://[any-host]:3001
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"https?://(localhost|[\d\.]+|[a-zA-Z0-9\-\.]+):(3000|3001)",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# API Request Logging Middleware
@app.middleware("http")
async def log_api_requests(request, call_next):
    """Log all API requests with appropriate log levels"""
    # Get request details
    method = request.method
    path = request.url.path
    query_params = dict(request.query_params) if request.query_params else None

    # Determine if this is a robot command endpoint
    robot_command_paths = [
        "/api/robot/move/", "/api/robot/jog/", "/api/robot/home",
        "/api/robot/stop", "/api/robot/gripper/", "/api/robot/motion/",
        "/api/robot/delay"
    ]
    is_robot_command = any(path.startswith(cmd) for cmd in robot_command_paths)

    # Read body for POST requests (only for logging, must re-create for handler)
    body_summary = None
    if method in ["POST", "PUT", "PATCH"]:
        try:
            body = await request.body()
            # Decode and truncate body for logging
            body_text = body.decode('utf-8')
            if len(body_text) > 200:
                body_summary = body_text[:200] + "..."
            else:
                body_summary = body_text if body_text else None

            # Re-create request with body for actual handler
            async def receive():
                return {"type": "http.request", "body": body}
            request._receive = receive
        except:
            body_summary = None

    # Format log message
    log_parts = [f"{method} {path}"]
    if query_params:
        log_parts.append(f"params={query_params}")
    if body_summary:
        log_parts.append(f"body={body_summary}")
    log_message = f"[API] {' - '.join(log_parts)}"

    # Log at appropriate level
    if is_robot_command:
        logger.info(log_message)
    else:
        logger.debug(log_message)

    # Process request
    response = await call_next(request)

    return response


# ============================================================================
# Helper Functions
# ============================================================================

def parse_robot_status() -> RobotStatus:
    """Get current robot status from robot_api"""
    try:
        # Get all status data
        pose_data = robot_client.get_robot_pose()
        joint_data = robot_client.get_robot_joint_angles()
        speed_data = robot_client.get_robot_joint_speeds()
        io_data = robot_client.get_robot_io()
        gripper_data = robot_client.get_electric_gripper_status()
        homed_data = robot_client.get_homed_status()
        commander_hz = robot_client.get_commander_hz()

        # Build status object
        # Only set is_stopped/estop_active if we have data, otherwise leave as None
        # NOTE: estop_active tracks the SOFTWARE e-stop flag (blocks motion until cleared),
        # not the physical button (available in ioStatus.estop_pressed)
        status = RobotStatus(
            is_stopped=robot_client.is_robot_stopped() if speed_data else None,
            estop_active=robot_client.get_software_estop_status(),
            homed=homed_data,
            commander_hz=commander_hz
        )
        
        if pose_data:
            status.pose = RobotPose(
                x=pose_data[0],
                y=pose_data[1],
                z=pose_data[2],
                roll=pose_data[3],
                pitch=pose_data[4],
                yaw=pose_data[5]
            )
            
        if joint_data:
            status.joints = JointAngles(angles=joint_data)
            
        if speed_data:
            status.speeds = JointSpeeds(speeds=speed_data)
            
        if io_data and len(io_data) >= 5:
            status.io = IOStatus(
                input_1=bool(io_data[0]),
                input_2=bool(io_data[1]),
                output_1=bool(io_data[2]),
                output_2=bool(io_data[3]),
                estop_pressed=io_data[4] == 0
            )
            
        if gripper_data and len(gripper_data) >= 6:
            status_byte = gripper_data[4]
            status.gripper = GripperStatus(
                device_id=gripper_data[0],
                position=gripper_data[1],
                speed=gripper_data[2],
                current=gripper_data[3],
                status_byte=status_byte,
                object_detected=gripper_data[5],
                is_calibrated=(status_byte & 0b10000000) != 0,
                is_active=(status_byte & 0b00000001) != 0,
                is_moving=(status_byte & 0b00000010) != 0
            )
            
        return status
        
    except Exception as e:
        logger.error(f"Error parsing robot status: {e}")
        return RobotStatus(is_stopped=None, estop_active=None)


async def stream_robot_status():
    """Background task to stream robot status via WebSocket"""
    logger.info("Starting robot status streaming task")

    while True:
        try:
            # Only fetch and broadcast if we have connected clients
            if manager.get_connection_count() > 0:
                status = await asyncio.to_thread(parse_robot_status)
                await manager.broadcast_robot_status(status)

            # Sleep based on highest client rate (minimum interval)
            if manager.update_rates:
                max_rate = max(manager.update_rates.values())
                sleep_time = 1.0 / max_rate
            else:
                sleep_time = 0.1  # Default 10Hz

            await asyncio.sleep(sleep_time)

        except asyncio.CancelledError:
            logger.info("Robot status streaming task cancelled")
            break
        except Exception as e:
            logger.error(f"Error in status streaming: {e}")
            await asyncio.sleep(1.0)  # Back off on error


async def stream_system_status():
    """Background task to stream system metrics via WebSocket"""
    logger.info("Starting system status streaming task")

    while True:
        try:
            # Only fetch and broadcast if we have connected clients subscribed to 'system' topic
            if manager.get_connection_count() > 0:
                # Check if any clients are subscribed to 'system'
                system_subscribers = [cid for cid in manager.active_connections.keys()
                                    if 'system' in manager.subscriptions.get(cid, set())]
                if len(system_subscribers) == 0:
                    await asyncio.sleep(1.0)
                    continue

                # Get system metrics
                cpu_percent = psutil.cpu_percent(interval=0.1)
                cpu_per_core = psutil.cpu_percent(interval=0.1, percpu=True)
                cpu_temp = get_cpu_temperature()
                memory = psutil.virtual_memory()
                disk = psutil.disk_usage('/')
                pm2_processes = get_pm2_status()
                uptime = get_system_uptime()

                system_metrics = {
                    "timestamp": datetime.now().isoformat(),
                    "cpu": {
                        "percent": cpu_percent,
                        "per_core": cpu_per_core,
                        "temperature": cpu_temp,
                        "count": psutil.cpu_count()
                    },
                    "memory": {
                        "percent": memory.percent,
                        "used_mb": memory.used / (1024 ** 2),
                        "total_mb": memory.total / (1024 ** 2),
                        "available_mb": memory.available / (1024 ** 2)
                    },
                    "disk": {
                        "percent": disk.percent,
                        "used_gb": disk.used / (1024 ** 3),
                        "total_gb": disk.total / (1024 ** 3),
                        "free_gb": disk.free / (1024 ** 3)
                    },
                    "pm2_processes": pm2_processes,
                    "uptime_seconds": uptime
                }

                # Broadcast to clients subscribed to 'system' topic
                # Send directly to each subscribed client
                for client_id, websocket in list(manager.active_connections.items()):
                    # Check if client is subscribed to 'system' topic
                    if 'system' in manager.subscriptions.get(client_id, set()):
                        try:
                            system_message = {
                                "type": "system",
                                "data": system_metrics,
                                "timestamp": datetime.now().isoformat()
                            }
                            message_json = json.dumps(system_message, default=str)
                            await websocket.send_text(message_json)
                        except Exception as e:
                            logger.error(f"Error sending system data to {client_id}: {e}")

            # Update at 1 Hz (less frequent than robot data)
            await asyncio.sleep(1.0)

        except asyncio.CancelledError:
            logger.info("System status streaming task cancelled")
            break
        except Exception as e:
            logger.error(f"Error in system status streaming: {e}")
            await asyncio.sleep(2.0)  # Back off on error


def execute_robot_command(func, *args, **kwargs) -> CommandResponse:
    """Execute a robot command and return response"""
    try:
        # Execute command
        result = func(*args, **kwargs)
        
        # Handle different response types
        if isinstance(result, dict):
            # Command with acknowledgment
            return CommandResponse(
                success=result.get('status') not in ['FAILED', 'INVALID'],
                command_id=result.get('command_id'),
                message=result.get('details', 'Command executed'),
                status=result.get('status'),
                details=result.get('details')
            )
        elif isinstance(result, str):
            # Simple command response
            if result.startswith("Command sent with tracking"):
                # Extract command ID
                cmd_id = result.split("ID: ")[-1].rstrip(")")
                return CommandResponse(
                    success=True,
                    command_id=cmd_id,
                    message=result,
                    status="SENT"
                )
            else:
                return CommandResponse(
                    success=not result.startswith("Error"),
                    message=result
                )
        elif result is None:
            # Non-blocking command that returned command ID
            return CommandResponse(
                success=True,
                command_id=str(result) if result else None,
                message="Command sent",
                status="SENT"
            )
        else:
            # Unknown response type
            return CommandResponse(
                success=True,
                message=str(result)
            )
            
    except Exception as e:
        logger.error(f"Error executing robot command: {e}")
        return CommandResponse(
            success=False,
            message=f"Error: {str(e)}",
            status="FAILED"
        )


# ============================================================================
# System Monitoring Helpers
# ============================================================================

def get_cpu_temperature() -> Optional[float]:
    """Get CPU temperature from Raspberry Pi thermal zone"""
    try:
        # Try primary thermal zone (CPU)
        temp_path = Path("/sys/class/thermal/thermal_zone0/temp")
        if temp_path.exists():
            temp_str = temp_path.read_text().strip()
            return float(temp_str) / 1000.0  # Convert millidegrees to degrees
    except Exception as e:
        logger.debug(f"Could not read CPU temperature: {e}")

    # Fallback: try vcgencmd for GPU temperature
    try:
        result = subprocess.run(
            ["vcgencmd", "measure_temp"],
            capture_output=True,
            text=True,
            timeout=1
        )
        if result.returncode == 0:
            # Output format: temp=42.8'C
            temp_str = result.stdout.strip().split("=")[1].split("'")[0]
            return float(temp_str)
    except Exception as e:
        logger.debug(f"Could not read GPU temperature via vcgencmd: {e}")

    return None


def get_pm2_status() -> list:
    """Get PM2 process status via pm2 jlist command"""
    try:
        result = subprocess.run(
            ["pm2", "jlist"],
            capture_output=True,
            text=True,
            timeout=5
        )
        if result.returncode == 0:
            processes = json.loads(result.stdout)
            return [
                {
                    "name": p.get("name"),
                    "pid": p.get("pid"),
                    "status": p.get("pm2_env", {}).get("status"),
                    "cpu": p.get("monit", {}).get("cpu", 0),
                    "memory": p.get("monit", {}).get("memory", 0),
                    "uptime": p.get("pm2_env", {}).get("pm_uptime"),
                    "restarts": p.get("pm2_env", {}).get("restart_time", 0),
                }
                for p in processes
            ]
    except Exception as e:
        logger.error(f"Could not get PM2 status: {e}")

    return []


def get_system_uptime() -> float:
    """Get system uptime in seconds"""
    try:
        return time.time() - psutil.boot_time()
    except Exception:
        return 0.0


# ============================================================================
# REST API Endpoints
# ============================================================================

@app.get("/")
async def root():
    """Root endpoint"""
    return {
        "message": "PAROL6 Robot API Server",
        "version": "1.0.0",
        "endpoints": {
            "docs": "/docs",
            "websocket": "/ws",
            "robot_status": "/api/robot/status"
        }
    }


@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {
        "status": "healthy",
        "timestamp": datetime.now().isoformat(),
        "websocket_clients": manager.get_connection_count()
    }


# System Monitoring Endpoints
@app.get("/api/system/status")
async def get_system_status():
    """
    Get comprehensive system health metrics including CPU, memory, disk,
    temperature, and PM2 process status.
    """
    try:
        # Get CPU info
        cpu_percent = psutil.cpu_percent(interval=0.1)
        cpu_per_core = psutil.cpu_percent(interval=0.1, percpu=True)
        cpu_temp = get_cpu_temperature()

        # Get memory info
        memory = psutil.virtual_memory()

        # Get disk info
        disk = psutil.disk_usage('/')

        # Get PM2 process info
        pm2_processes = get_pm2_status()

        # Get uptime
        uptime = get_system_uptime()

        return {
            "timestamp": datetime.now().isoformat(),
            "cpu": {
                "percent": cpu_percent,
                "per_core": cpu_per_core,
                "temperature": cpu_temp,
                "count": psutil.cpu_count()
            },
            "memory": {
                "percent": memory.percent,
                "used_mb": memory.used / (1024 ** 2),
                "total_mb": memory.total / (1024 ** 2),
                "available_mb": memory.available / (1024 ** 2)
            },
            "disk": {
                "percent": disk.percent,
                "used_gb": disk.used / (1024 ** 3),
                "total_gb": disk.total / (1024 ** 3),
                "free_gb": disk.free / (1024 ** 3)
            },
            "pm2_processes": pm2_processes,
            "uptime_seconds": uptime
        }
    except Exception as e:
        logger.error(f"Error getting system status: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to get system status: {str(e)}")


@app.post("/api/system/restart/{process_name}")
async def restart_pm2_process(process_name: str):
    """
    Restart a specific PM2 process by name.
    Valid process names: parol-nextjs, parol-commander, parol-api
    """
    try:
        # Validate process name (security check)
        valid_processes = ["parol-nextjs", "parol-commander", "parol-api"]
        if process_name not in valid_processes:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid process name. Must be one of: {', '.join(valid_processes)}"
            )

        # Execute PM2 restart command
        result = subprocess.run(
            ["pm2", "restart", process_name],
            capture_output=True,
            text=True,
            timeout=10
        )

        if result.returncode == 0:
            logger.info(f"Successfully restarted PM2 process: {process_name}")
            return {
                "success": True,
                "message": f"Process '{process_name}' restarted successfully",
                "process_name": process_name
            }
        else:
            logger.error(f"Failed to restart PM2 process {process_name}: {result.stderr}")
            raise HTTPException(
                status_code=500,
                detail=f"Failed to restart process: {result.stderr}"
            )

    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=500, detail="PM2 restart command timed out")
    except Exception as e:
        logger.error(f"Error restarting PM2 process {process_name}: {e}")
        raise HTTPException(status_code=500, detail=f"Error: {str(e)}")


# Status Endpoints
@app.post("/api/robot/move/joints", response_model=CommandResponse)
async def move_joints(request: MoveJointsRequest):
    """Move robot joints to specified angles"""
    # Note: Commanded target logging now happens in commander when command starts executing
    return execute_robot_command(
        robot_client.move_robot_joints,
        request.angles,
        duration=request.duration,
        speed_percentage=request.speed_percentage,
        wait_for_ack=request.wait_for_ack,
        timeout=request.timeout
    )


@app.post("/api/robot/execute/trajectory", response_model=CommandResponse)
async def execute_trajectory_endpoint(request: ExecuteTrajectoryRequest):
    """
    Execute a pre-computed joint trajectory at 100Hz.

    **Motion Type**: Pre-computed joint-space trajectory

    **How it works**:
    1. Frontend generates Cartesian waypoints dynamically
    2. Backend batch IK solves all waypoints ONCE (offline planning)
    3. This endpoint executes the joint trajectory at 100Hz

    **Advantages**:
    - Achieves 100Hz execution (same as MoveJoint)
    - Cartesian straight-line motion in task space
    - No real-time IK overhead (all IK done offline)

    **Use cases**:
    - Cartesian straight-line motion with guaranteed 100Hz performance
    - Complex multi-point trajectories
    - Motion where both path and speed matter

    **Workflow**:
    ```
    1. Generate Cartesian waypoints → /api/ik/batch → Get joint trajectory
    2. Execute joint trajectory → /api/robot/execute/trajectory
    ```

    **Example**: Drawing a straight line at constant speed in 3D space
    """
    # Note: Commanded target logging now happens in commander when command starts executing
    return execute_robot_command(
        robot_client.execute_trajectory,
        request.trajectory,
        duration=request.duration,
        wait_for_ack=request.wait_for_ack,
        timeout=request.timeout
    )


# Jog Endpoints
@app.post("/api/robot/gripper/electric", response_model=CommandResponse)
async def control_electric_gripper(request: ElectricGripperRequest):
    """Control electric gripper"""
    return execute_robot_command(
        robot_client.control_electric_gripper,
        request.action,
        position=request.position,
        speed=request.speed,
        current=request.current,
        wait_for_ack=request.wait_for_ack,
        timeout=request.timeout
    )


@app.post("/api/robot/io/set", response_model=CommandResponse)
async def set_io(request: SetIORequest):
    """Set digital output state"""
    return execute_robot_command(
        robot_client.set_io,
        request.output,
        request.state,
        wait_for_ack=request.wait_for_ack,
        timeout=request.timeout
    )


# Control Endpoints
@app.post("/api/robot/home", response_model=CommandResponse)
async def home_robot():
    """Home the robot"""
    return execute_robot_command(
        robot_client.home_robot,
        wait_for_ack=True,
        timeout=30.0
    )


@app.post("/api/robot/stop", response_model=CommandResponse)
async def stop_robot():
    """Emergency stop robot movement"""
    return execute_robot_command(
        robot_client.stop_robot_movement,
        wait_for_ack=True,
        timeout=2.0
    )


@app.post("/api/robot/clear-estop", response_model=CommandResponse)
async def clear_estop():
    """Clear software E-stop flag to re-enable robot motion"""
    return execute_robot_command(
        robot_client.clear_estop,
        wait_for_ack=True,
        timeout=2.0
    )


@app.post("/api/robot/delay", response_model=CommandResponse)
async def delay_robot(request: DelayRequest):
    """Add delay to robot execution"""
    return execute_robot_command(
        robot_client.delay_robot,
        request.duration,
        wait_for_ack=request.wait_for_ack,
        timeout=request.timeout
    )


# Smooth Motion Endpoints
@app.get("/api/robot/command/{command_id}", response_model=CommandAcknowledgment)
async def get_command_status(command_id: str):
    """Get status of a tracked command"""
    status = robot_client.check_command_status(command_id)
    if not status:
        raise HTTPException(status_code=404, detail="Command not found or tracking not active")
    
    return CommandAcknowledgment(
        command_id=command_id,
        status=status.get('status', 'UNKNOWN'),
        details=status.get('details'),
        completed=status.get('completed', False),
        ack_time=status.get('ack_time')
    )


# ============================================================================
# WebSocket Endpoint
# ============================================================================

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """WebSocket endpoint for real-time robot data"""
    client_id = str(uuid.uuid4())

    try:
        # Connect client
        await manager.connect(websocket, client_id)

        # Send welcome message
        await manager.send_json_to_client({
            "type": "connected",
            "client_id": client_id,
            "message": "Connected to PAROL6 Robot WebSocket",
            "timestamp": datetime.now().isoformat()
        }, client_id)

        # Send historical logs if configured
        initial_log_count = config.get('logging', {}).get('initial_log_count', 100)
        if initial_log_count > 0:
            historical_logs = websocket_handler.get_logs(limit=initial_log_count)
            for log_entry in historical_logs:
                await manager.send_json_to_client({
                    "type": "log",
                    "data": log_entry
                }, client_id)
            logger.debug(f"Sent {len(historical_logs)} historical log entries to client {client_id}")

        # Handle messages
        while True:
            # Receive message from client
            message = await websocket.receive_text()
            await manager.handle_client_message(client_id, message)
            
    except WebSocketDisconnect:
        manager.disconnect(client_id)
        logger.debug(f"WebSocket client {client_id} disconnected")
    except Exception as e:
        logger.error(f"WebSocket error for client {client_id}: {e}")
        manager.disconnect(client_id)


@app.get("/api/websocket/clients")
async def get_websocket_clients():
    """Get information about connected WebSocket clients"""
    return {
        "count": manager.get_connection_count(),
        "clients": manager.get_client_info()
    }


# Configuration Endpoints
@app.get("/api/config")
async def get_config():
    """Get current configuration"""
    try:
        with open(CONFIG_PATH, "r") as f:
            return yaml.safe_load(f)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Configuration file not found")


@app.patch("/api/config")
async def update_config(updates: Dict[str, Any]):
    """Update configuration (partial update supported)"""
    try:
        # Load current config
        with open(CONFIG_PATH, "r") as f:
            current_config = yaml.safe_load(f)

        # Deep merge updates
        def deep_merge(base, updates):
            for key, value in updates.items():
                if key in base and isinstance(base[key], dict) and isinstance(value, dict):
                    deep_merge(base[key], value)
                else:
                    base[key] = value

        deep_merge(current_config, updates)

        # Save updated config
        with open(CONFIG_PATH, "w") as f:
            yaml.dump(current_config, f, default_flow_style=False)
        
        return {"message": "Configuration updated successfully", "config": current_config}
    
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to update configuration: {str(e)}")


@app.get("/api/config/com-ports")
async def get_available_com_ports():
    """Get list of available COM ports (Windows only)"""
    try:
        import serial.tools.list_ports
        ports = serial.tools.list_ports.comports()
        return {
            "ports": [
                {
                    "device": port.device,
                    "description": port.description,
                    "hwid": port.hwid
                }
                for port in ports
            ]
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to list COM ports: {str(e)}")


# URDF Configuration Endpoints
@app.post("/api/urdf/update-gripper")
async def update_urdf_gripper(
    mesh_filename: str,
    mesh_offset_position: Dict[str, float],  # {x, y, z} in meters
    mesh_offset_rotation: Dict[str, float],  # {rx, ry, rz} in degrees
    tcp_offset_position: Dict[str, float],   # {x, y, z} in mm
    tcp_offset_rotation: Dict[str, float],   # {rx, ry, rz} in degrees
    stl_data: Optional[str] = None  # Base64 encoded STL file data (optional)
):
    """
    Update URDF with custom gripper configuration.
    Modifies L6 link visual origin and saves TCP offset to config.yaml

    Args:
        mesh_filename: Name of the STL file (e.g., "custom_gripper.STL")
        mesh_offset_position: Position offset {x, y, z} in meters
        mesh_offset_rotation: Rotation offset {rx, ry, rz} in degrees
        tcp_offset_position: TCP position offset {x, y, z} in mm
        tcp_offset_rotation: TCP orientation offset {rx, ry, rz} in degrees
        stl_data: Optional base64 encoded STL file data to save
    """
    try:
        mesh_filename = safe_filename(mesh_filename)
        urdf_path = PROJECT_ROOT / "frontend" / "public" / "urdf" / "PAROL6.urdf"
        meshes_dir = PROJECT_ROOT / "frontend" / "public" / "urdf" / "meshes"

        if not urdf_path.exists():
            raise HTTPException(status_code=404, detail="URDF file not found")

        # Parse URDF XML
        tree = ET.parse(urdf_path)
        root = tree.getroot()

        # Find L6 link
        l6_link = None
        for link in root.findall(".//link[@name='L6']"):
            l6_link = link
            break

        if l6_link is None:
            raise HTTPException(status_code=404, detail="L6 link not found in URDF")

        # Find or create visual element
        visual = l6_link.find("visual")
        if visual is None:
            visual = ET.SubElement(l6_link, "visual")

        # Update visual origin
        origin = visual.find("origin")
        if origin is None:
            origin = ET.SubElement(visual, "origin")

        # Convert rotation from degrees to radians for rpy attribute
        import math
        rx_rad = mesh_offset_rotation['rx'] * math.pi / 180
        ry_rad = mesh_offset_rotation['ry'] * math.pi / 180
        rz_rad = mesh_offset_rotation['rz'] * math.pi / 180

        # Set xyz and rpy attributes
        origin.set("xyz", f"{mesh_offset_position['x']} {mesh_offset_position['y']} {mesh_offset_position['z']}")
        origin.set("rpy", f"{rx_rad} {ry_rad} {rz_rad}")

        # Update mesh filename
        geometry = visual.find("geometry")
        if geometry is None:
            geometry = ET.SubElement(visual, "geometry")

        mesh = geometry.find("mesh")
        if mesh is None:
            mesh = ET.SubElement(geometry, "mesh")

        mesh.set("filename", f"./meshes/{mesh_filename}")

        # Save STL file if provided
        if stl_data:
            meshes_dir.mkdir(parents=True, exist_ok=True)
            stl_path = meshes_dir / mesh_filename

            # Decode base64 and save
            stl_bytes = base64.b64decode(stl_data)
            with open(stl_path, "wb") as f:
                f.write(stl_bytes)

            logger.info(f"Saved STL file to {stl_path}")

        # Save updated URDF
        tree.write(urdf_path, encoding="utf-8", xml_declaration=True)
        logger.info(f"Updated URDF at {urdf_path}")

        # Update config.yaml with TCP offset
        try:
            with open(CONFIG_PATH, "r") as f:
                current_config = yaml.safe_load(f)

            # Update tcp_offset in ui section
            # Note: TCP offset is now managed per-tool, not globally
            # The URDF update no longer syncs to a global tcp_offset config
            logger.info(f"URDF updated (TCP offset managed per-tool)")

        except Exception as e:
            logger.warning(f"Failed to update config.yaml: {e}")
            # Don't fail the whole request if config update fails

        return {
            "message": "URDF and configuration updated successfully",
            "urdf_path": str(urdf_path),
            "mesh_path": f"./meshes/{mesh_filename}",
            "tcp_offset": {
                "position": tcp_offset_position,
                "rotation": tcp_offset_rotation
            }
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to update URDF: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to update URDF: {str(e)}")


# Tool Management CRUD Endpoints
@app.get("/api/config/tools")
async def get_tools():
    """Get all tools in the tool library"""
    try:
        with open(CONFIG_PATH, "r") as f:
            config = yaml.safe_load(f)

        tools = config.get('ui', {}).get('tools', [])
        active_id = config.get('ui', {}).get('active_tool', None)

        return {
            "tools": tools,
            "active_tool_id": active_id
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load tools: {str(e)}")


@app.get("/api/config/tools/{tool_id}")
async def get_tool(tool_id: str):
    """Get single tool by ID"""
    try:
        with open(CONFIG_PATH, "r") as f:
            config = yaml.safe_load(f)

        tools = config.get('ui', {}).get('tools', [])
        tool = next((t for t in tools if t['id'] == tool_id), None)

        if not tool:
            raise HTTPException(status_code=404, detail=f"Tool '{tool_id}' not found")

        return tool
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load tool: {str(e)}")


@app.post("/api/config/tools")
async def create_tool(request: CreateToolRequest):
    """Create new tool"""
    try:
        # Generate tool ID from name (slugify)
        tool_id = re.sub(r'[^a-z0-9]+', '_', request.name.lower()).strip('_')

        # Ensure ID is unique
        with open(CONFIG_PATH, "r") as f:
            config = yaml.safe_load(f)

        if 'ui' not in config:
            config['ui'] = {}
        if 'tools' not in config['ui']:
            config['ui']['tools'] = []

        tools = config['ui']['tools']

        # Check for duplicate ID
        if any(t['id'] == tool_id for t in tools):
            # Append number to make unique
            counter = 1
            while any(t['id'] == f"{tool_id}_{counter}" for t in tools):
                counter += 1
            tool_id = f"{tool_id}_{counter}"

        # Create new tool
        new_tool = {
            "id": tool_id,
            "name": request.name,
            "description": request.description,
            "mesh_file": request.mesh_file,
            "mesh_units": request.mesh_units if request.mesh_units else "mm",
            "mesh_offset": {
                "x": request.mesh_offset_position.x,
                "y": request.mesh_offset_position.y,
                "z": request.mesh_offset_position.z,
                "rx": request.mesh_offset_rotation.rx,
                "ry": request.mesh_offset_rotation.ry,
                "rz": request.mesh_offset_rotation.rz
            },
            "tcp_offset": {
                "x": request.tcp_offset_position.x,
                "y": request.tcp_offset_position.y,
                "z": request.tcp_offset_position.z,
                "rx": request.tcp_offset_rotation.rx,
                "ry": request.tcp_offset_rotation.ry,
                "rz": request.tcp_offset_rotation.rz
            }
        }

        # Add gripper config if provided
        if request.gripper_config:
            new_tool["gripper_config"] = {
                "enabled": request.gripper_config.enabled,
                "io_pin": request.gripper_config.io_pin,
                "open_is_high": request.gripper_config.open_is_high,
                "mesh_file_open": request.gripper_config.mesh_file_open,
                "mesh_file_closed": request.gripper_config.mesh_file_closed
            }

        meshes_dir = PROJECT_ROOT / "frontend" / "public" / "urdf" / "meshes"
        meshes_dir.mkdir(parents=True, exist_ok=True)

        # Save main STL file if provided
        if request.stl_data and request.mesh_file:
            stl_path = meshes_dir / safe_filename(request.mesh_file)
            stl_bytes = base64.b64decode(request.stl_data)
            with open(stl_path, "wb") as f:
                f.write(stl_bytes)
            logger.info(f"Saved STL file to {stl_path}")

        # Save open state STL if provided
        if request.stl_data_open and request.gripper_config and request.gripper_config.mesh_file_open:
            stl_path = meshes_dir / safe_filename(request.gripper_config.mesh_file_open)
            stl_bytes = base64.b64decode(request.stl_data_open)
            with open(stl_path, "wb") as f:
                f.write(stl_bytes)
            logger.info(f"Saved open state STL file to {stl_path}")

        # Save closed state STL if provided
        if request.stl_data_closed and request.gripper_config and request.gripper_config.mesh_file_closed:
            stl_path = meshes_dir / safe_filename(request.gripper_config.mesh_file_closed)
            stl_bytes = base64.b64decode(request.stl_data_closed)
            with open(stl_path, "wb") as f:
                f.write(stl_bytes)
            logger.info(f"Saved closed state STL file to {stl_path}")

        # Add to tools list
        tools.append(new_tool)

        # Save config
        with open(CONFIG_PATH, "w") as f:
            yaml.dump(config, f, default_flow_style=False)

        logger.info(f"Created tool: {tool_id}")

        return {
            "message": "Tool created successfully",
            "tool": new_tool
        }

    except Exception as e:
        logger.error(f"Failed to create tool: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to create tool: {str(e)}")


@app.patch("/api/config/tools/{tool_id}")
async def update_tool(tool_id: str, request: UpdateToolRequest):
    """Update existing tool"""
    try:
        with open(CONFIG_PATH, "r") as f:
            config = yaml.safe_load(f)

        tools = config.get('ui', {}).get('tools', [])
        tool_index = next((i for i, t in enumerate(tools) if t['id'] == tool_id), None)

        if tool_index is None:
            raise HTTPException(status_code=404, detail=f"Tool '{tool_id}' not found")

        tool = tools[tool_index]

        # Update fields if provided
        if request.name is not None:
            tool['name'] = request.name
        if request.description is not None:
            tool['description'] = request.description
        if request.mesh_file is not None:
            tool['mesh_file'] = request.mesh_file
        if request.mesh_units is not None:
            tool['mesh_units'] = request.mesh_units

        if request.mesh_offset_position is not None:
            tool['mesh_offset']['x'] = request.mesh_offset_position.x
            tool['mesh_offset']['y'] = request.mesh_offset_position.y
            tool['mesh_offset']['z'] = request.mesh_offset_position.z

        if request.mesh_offset_rotation is not None:
            tool['mesh_offset']['rx'] = request.mesh_offset_rotation.rx
            tool['mesh_offset']['ry'] = request.mesh_offset_rotation.ry
            tool['mesh_offset']['rz'] = request.mesh_offset_rotation.rz

        if request.tcp_offset_position is not None:
            tool['tcp_offset']['x'] = request.tcp_offset_position.x
            tool['tcp_offset']['y'] = request.tcp_offset_position.y
            tool['tcp_offset']['z'] = request.tcp_offset_position.z

        if request.tcp_offset_rotation is not None:
            tool['tcp_offset']['rx'] = request.tcp_offset_rotation.rx
            tool['tcp_offset']['ry'] = request.tcp_offset_rotation.ry
            tool['tcp_offset']['rz'] = request.tcp_offset_rotation.rz

        # Update gripper config if provided
        if request.gripper_config is not None:
            if 'gripper_config' not in tool:
                tool['gripper_config'] = {}
            tool['gripper_config']['enabled'] = request.gripper_config.enabled
            tool['gripper_config']['io_pin'] = request.gripper_config.io_pin
            tool['gripper_config']['open_is_high'] = request.gripper_config.open_is_high
            tool['gripper_config']['mesh_file_open'] = request.gripper_config.mesh_file_open
            tool['gripper_config']['mesh_file_closed'] = request.gripper_config.mesh_file_closed

        meshes_dir = PROJECT_ROOT / "frontend" / "public" / "urdf" / "meshes"
        meshes_dir.mkdir(parents=True, exist_ok=True)

        # Save main STL file if provided
        if request.stl_data and request.mesh_file:
            stl_path = meshes_dir / safe_filename(request.mesh_file)
            stl_bytes = base64.b64decode(request.stl_data)
            with open(stl_path, "wb") as f:
                f.write(stl_bytes)
            logger.info(f"Saved STL file to {stl_path}")

        # Save open state STL if provided
        if request.stl_data_open and request.gripper_config and request.gripper_config.mesh_file_open:
            stl_path = meshes_dir / safe_filename(request.gripper_config.mesh_file_open)
            stl_bytes = base64.b64decode(request.stl_data_open)
            with open(stl_path, "wb") as f:
                f.write(stl_bytes)
            logger.info(f"Saved open state STL file to {stl_path}")

        # Save closed state STL if provided
        if request.stl_data_closed and request.gripper_config and request.gripper_config.mesh_file_closed:
            stl_path = meshes_dir / safe_filename(request.gripper_config.mesh_file_closed)
            stl_bytes = base64.b64decode(request.stl_data_closed)
            with open(stl_path, "wb") as f:
                f.write(stl_bytes)
            logger.info(f"Saved closed state STL file to {stl_path}")

        # If this is the active tool, sync tcp_offset
        if config.get('ui', {}).get('active_tool') == tool_id:
            config['ui']['tcp_offset'] = tool['tcp_offset']
            logger.info(f"Synced tcp_offset from mounted tool {tool_id}")

        # Save config
        with open(CONFIG_PATH, "w") as f:
            yaml.dump(config, f, default_flow_style=False)

        logger.info(f"Updated tool: {tool_id}")

        return {
            "message": "Tool updated successfully",
            "tool": tool
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to update tool: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to update tool: {str(e)}")


@app.delete("/api/config/tools/{tool_id}")
async def delete_tool(tool_id: str):
    """Delete tool (cannot delete mounted tool)"""
    try:
        with open(CONFIG_PATH, "r") as f:
            config = yaml.safe_load(f)

        active_id = config.get('ui', {}).get('active_tool')

        # Prevent deleting mounted tool
        if active_id == tool_id:
            raise HTTPException(
                status_code=400,
                detail="Cannot remove mounted tool. Mount a different tool first."
            )

        tools = config.get('ui', {}).get('tools', [])
        tool_index = next((i for i, t in enumerate(tools) if t['id'] == tool_id), None)

        if tool_index is None:
            raise HTTPException(status_code=404, detail=f"Tool '{tool_id}' not found")

        # Remove tool
        deleted_tool = tools.pop(tool_index)

        # Save config
        with open(CONFIG_PATH, "w") as f:
            yaml.dump(config, f, default_flow_style=False)

        logger.info(f"Removed tool from library: {tool_id}")

        return {
            "message": f"Tool '{deleted_tool['name']}' removed from library"
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to delete tool: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to delete tool: {str(e)}")


@app.post("/api/config/tools/{tool_id}/mount")
async def mount_tool(tool_id: str):
    """Mount tool and sync tcp_offset"""
    try:
        with open(CONFIG_PATH, "r") as f:
            config = yaml.safe_load(f)

        tools = config.get('ui', {}).get('tools', [])
        tool = next((t for t in tools if t['id'] == tool_id), None)

        if not tool:
            raise HTTPException(status_code=404, detail=f"Tool '{tool_id}' not found")

        # Update active tool ID
        config['ui']['active_tool'] = tool_id

        # Note: TCP offset is now read from active tool, not synced to global config

        # Save config
        with open(CONFIG_PATH, "w") as f:
            yaml.dump(config, f, default_flow_style=False)

        logger.info(f"Mounted tool: {tool_id}")

        return {
            "message": f"Tool '{tool['name']}' mounted successfully",
            "tool": tool,
            "tcp_offset": tool['tcp_offset']
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to mount tool: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to mount tool: {str(e)}")


# --- Custom Robot Profiles (drag & drop URDF + meshes) ---------------------
# See Configuration > Robot Model in the frontend, and AUDIT.md, for the full
# picture of what this does and doesn't cover. Short version: this safely
# handles visualization and joint-space jogging/limits for any 6-joint
# (revolute or continuous) URDF. It deliberately does NOT touch Cartesian/IK
# geometry (DH parameters) - those stay on PAROL6's values until a human
# fills them in, because they can't be derived safely from an STL/URDF drop.

ROBOT_PROFILES_DIR_NAME = "custom"  # under frontend/public/urdf/


def _custom_robots_root() -> Path:
    root = PROJECT_ROOT / "frontend" / "public" / "urdf" / ROBOT_PROFILES_DIR_NAME
    root.mkdir(parents=True, exist_ok=True)
    return root


def _slugify_robot_name(name: str, existing_ids: set) -> str:
    base = re.sub(r'[^a-z0-9]+', '_', name.lower()).strip('_') or "robot"
    if base == "parol6":
        base = f"{base}_custom"
    slug = base
    counter = 1
    while slug in existing_ids:
        counter += 1
        slug = f"{base}_{counter}"
    return slug


def _load_robot_profiles_config(config: dict) -> dict:
    """Get (and if missing, create) the robot_profiles block in a loaded config dict."""
    if "robot_profiles" not in config or not isinstance(config.get("robot_profiles"), dict):
        config["robot_profiles"] = {"active": "parol6", "custom": []}
    config["robot_profiles"].setdefault("active", "parol6")
    config["robot_profiles"].setdefault("custom", [])
    return config["robot_profiles"]


@app.get("/api/config/robot/profiles")
async def list_robot_profiles():
    """List the built-in PAROL6 profile plus any uploaded custom robots."""
    try:
        with open(CONFIG_PATH, "r") as f:
            config = yaml.safe_load(f) or {}
        profiles_cfg = _load_robot_profiles_config(config)
        active_id = profiles_cfg["active"]

        profiles = [{
            "id": "parol6",
            "name": "PAROL6 (default)",
            "builtin": True,
            "urdf_path": "/urdf/PAROL6.urdf",
            "joint_names": ["L1", "L2", "L3", "L4", "L5", "L6"],
            "has_dh_params": True,
            "active": active_id == "parol6",
        }]
        for entry in profiles_cfg["custom"]:
            profiles.append({
                "id": entry["id"],
                "name": entry.get("name", entry["id"]),
                "builtin": False,
                "urdf_path": entry.get("urdf_path"),
                "joint_names": entry.get("joint_names", []),
                "joint_limits_deg": entry.get("joint_limits_deg"),
                "dh_params": entry.get("dh_params"),
                "has_dh_params": entry.get("dh_params") is not None,
                "active": entry["id"] == active_id,
            })

        return {"profiles": profiles, "active": active_id}
    except Exception as e:
        logger.error(f"Failed to list robot profiles: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to list robot profiles: {str(e)}")


@app.post("/api/config/robot/upload")
async def upload_robot(request: UploadRobotRequest):
    """
    Register a new custom robot from a dropped URDF + mesh files.

    Validates that the URDF parses, that all 6 mapped joint names actually
    exist in it as revolute/continuous joints, and that every mesh the URDF
    references was actually uploaded - before writing anything to disk.
    """
    try:
        # 1. Decode and parse the URDF first; reject anything malformed
        #    before touching the filesystem.
        try:
            urdf_bytes = base64.b64decode(request.urdf_data)
            urdf_text = urdf_bytes.decode("utf-8")
        except Exception:
            raise HTTPException(status_code=400, detail="urdf_data is not valid base64/UTF-8")

        try:
            root = ET.fromstring(urdf_text)
        except ET.ParseError as e:
            raise HTTPException(status_code=400, detail=f"Could not parse URDF XML: {e}")

        if root.tag != "robot":
            raise HTTPException(status_code=400, detail=f"Expected a <robot> root element, got <{root.tag}>")

        # 2. Validate the 6 mapped joints exist and are revolute/continuous
        movable_joints = {
            j.get("name"): j for j in root.findall("joint")
            if j.get("type") in ("revolute", "continuous")
        }
        missing = [name for name in request.joint_mapping if name not in movable_joints]
        if missing:
            raise HTTPException(
                status_code=400,
                detail=f"These joint names from your mapping were not found as revolute/continuous "
                       f"joints in the URDF: {missing}. Found joints: {sorted(movable_joints.keys())}"
            )
        if len(set(request.joint_mapping)) != 6:
            raise HTTPException(status_code=400, detail="joint_mapping must name 6 distinct joints")

        # 3. Derive J1..J6 joint limits (degrees) straight from the URDF
        joint_limits_deg = []
        for joint_name in request.joint_mapping:
            joint_el = movable_joints[joint_name]
            limit_el = joint_el.find("limit")
            if joint_el.get("type") == "continuous" and limit_el is None:
                joint_limits_deg.append([-360.0, 360.0])
                continue
            if limit_el is None or limit_el.get("lower") is None or limit_el.get("upper") is None:
                raise HTTPException(
                    status_code=400,
                    detail=f"Joint '{joint_name}' has no <limit lower=\"\" upper=\"\"> and isn't "
                           f"continuous - add explicit limits in the URDF before uploading."
                )
            lower_deg = math.degrees(float(limit_el.get("lower")))
            upper_deg = math.degrees(float(limit_el.get("upper")))
            joint_limits_deg.append([round(lower_deg, 4), round(upper_deg, 4)])

        # 4. Match every <mesh filename="..."> reference against uploaded files
        uploaded_by_basename = {}
        for mesh_file in request.meshes:
            safe_name = safe_filename(mesh_file.filename)
            uploaded_by_basename[safe_name] = (safe_name, mesh_file.data)

        referenced_basenames = set()
        mesh_elements = []
        for mesh_el in root.findall(".//mesh"):
            raw_filename = mesh_el.get("filename")
            if not raw_filename:
                continue
            basename = raw_filename.replace("\\", "/").split("/")[-1]
            referenced_basenames.add(basename)
            mesh_elements.append(mesh_el)

        missing_meshes = [b for b in referenced_basenames if b not in uploaded_by_basename]
        if missing_meshes:
            raise HTTPException(
                status_code=400,
                detail=f"The URDF references mesh files that weren't included in the drop: {sorted(missing_meshes)}"
            )

        # 5. Rewrite every <mesh filename> to point at ./meshes/<basename>,
        #    regardless of how the source URDF referenced them (absolute,
        #    package://, different relative layout, etc.) - matches the
        #    convention the rest of this app already uses for PAROL6.urdf.
        for mesh_el in mesh_elements:
            raw_filename = mesh_el.get("filename")
            basename = raw_filename.replace("\\", "/").split("/")[-1]
            mesh_el.set("filename", f"./meshes/{basename}")
        rewritten_urdf = ET.tostring(root, encoding="unicode")

        # 6. Pick a unique id/slug and write files to disk
        with open(CONFIG_PATH, "r") as f:
            config = yaml.safe_load(f) or {}
        profiles_cfg = _load_robot_profiles_config(config)
        existing_ids = {"parol6"} | {e["id"] for e in profiles_cfg["custom"]}

        # Re-uploading the same name updates that robot in place rather than
        # creating a duplicate.
        existing_entry = next((e for e in profiles_cfg["custom"]
                                if e.get("name") == request.name), None)
        slug = existing_entry["id"] if existing_entry else _slugify_robot_name(request.name, existing_ids)

        robot_dir = _custom_robots_root() / slug
        meshes_dir = robot_dir / "meshes"
        meshes_dir.mkdir(parents=True, exist_ok=True)

        urdf_filename = safe_filename(request.urdf_filename)
        urdf_path_on_disk = robot_dir / urdf_filename
        with open(urdf_path_on_disk, "w", encoding="utf-8") as f:
            f.write(rewritten_urdf)

        for basename, (_, data_b64) in uploaded_by_basename.items():
            if basename not in referenced_basenames:
                continue  # don't write files the URDF doesn't actually use
            with open(meshes_dir / basename, "wb") as f:
                f.write(base64.b64decode(data_b64))

        # 7. Record the profile in config.yaml
        profile_entry = {
            "id": slug,
            "name": request.name,
            "urdf_path": f"/urdf/{ROBOT_PROFILES_DIR_NAME}/{slug}/{urdf_filename}",
            "joint_names": list(request.joint_mapping),
            "joint_limits_deg": joint_limits_deg,
            "dh_params": existing_entry.get("dh_params") if existing_entry else None,
        }
        profiles_cfg["custom"] = [e for e in profiles_cfg["custom"] if e["id"] != slug] + [profile_entry]

        with open(CONFIG_PATH, "w") as f:
            yaml.dump(config, f, default_flow_style=False)

        logger.info(f"Registered custom robot profile '{slug}' ({len(uploaded_by_basename)} mesh files)")
        return {"message": f"Robot '{request.name}' uploaded successfully", "profile": profile_entry}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to upload custom robot: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to upload custom robot: {str(e)}")


@app.post("/api/config/robot/activate")
async def activate_robot_profile(request: ActivateRobotProfileRequest):
    """Make a robot profile (built-in PAROL6 or a custom upload) the active one."""
    try:
        with open(CONFIG_PATH, "r") as f:
            config = yaml.safe_load(f) or {}
        profiles_cfg = _load_robot_profiles_config(config)

        if request.id != "parol6" and not any(e["id"] == request.id for e in profiles_cfg["custom"]):
            raise HTTPException(status_code=404, detail=f"Robot profile '{request.id}' not found")

        profiles_cfg["active"] = request.id
        with open(CONFIG_PATH, "w") as f:
            yaml.dump(config, f, default_flow_style=False)

        logger.info(f"Activated robot profile: {request.id}")
        return {"message": f"Robot profile '{request.id}' is now active", "active": request.id}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to activate robot profile: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to activate robot profile: {str(e)}")


@app.post("/api/config/robot/profiles/{profile_id}/joint-limits")
async def save_robot_joint_limits(profile_id: str, request: SaveJointLimitsRequest):
    """
    Override a custom robot profile's joint limits (e.g. to add a safety
    margin beyond what the URDF specified, or correct a URDF that had the
    wrong limits). This is the same field upload populates automatically -
    this just lets you edit it afterward instead of re-uploading.
    """
    if profile_id == "parol6":
        raise HTTPException(status_code=400, detail="Cannot edit limits on the built-in PAROL6 profile")
    try:
        with open(CONFIG_PATH, "r") as f:
            config = yaml.safe_load(f) or {}
        profiles_cfg = _load_robot_profiles_config(config)

        entry = next((e for e in profiles_cfg["custom"] if e["id"] == profile_id), None)
        if entry is None:
            raise HTTPException(status_code=404, detail=f"Robot profile '{profile_id}' not found")

        for lo, hi in request.limits_deg:
            if lo >= hi:
                raise HTTPException(status_code=400, detail=f"Each joint's min must be less than its max (got [{lo}, {hi}])")

        entry["joint_limits_deg"] = [list(pair) for pair in request.limits_deg]

        with open(CONFIG_PATH, "w") as f:
            yaml.dump(config, f, default_flow_style=False)

        logger.info(f"Updated joint limits for robot profile '{profile_id}'")
        return {"message": f"Joint limits updated for '{entry['name']}'", "profile": entry}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to save joint limits: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to save joint limits: {str(e)}")


@app.post("/api/config/robot/profiles/{profile_id}/dh-params")
async def save_robot_dh_params(profile_id: str, request: SaveDHParamsRequest):
    """
    Save Cartesian/IK geometry (standard DH table) for a custom robot
    profile. Once this is set, lib/kinematics/robot_model.py builds its
    DHRobot from these values instead of PAROL6's for this profile - see
    AUDIT.md for why this is a deliberate, explicit step rather than
    something derived automatically from the URDF.
    """
    if profile_id == "parol6":
        raise HTTPException(status_code=400, detail="Cannot set DH parameters on the built-in PAROL6 profile")
    try:
        with open(CONFIG_PATH, "r") as f:
            config = yaml.safe_load(f) or {}
        profiles_cfg = _load_robot_profiles_config(config)

        entry = next((e for e in profiles_cfg["custom"] if e["id"] == profile_id), None)
        if entry is None:
            raise HTTPException(status_code=404, detail=f"Robot profile '{profile_id}' not found")

        entry["dh_params"] = {"joints": [j.dict() for j in request.joints]}

        with open(CONFIG_PATH, "w") as f:
            yaml.dump(config, f, default_flow_style=False)

        logger.info(f"Saved DH parameters for robot profile '{profile_id}'")
        return {
            "message": f"DH parameters saved for '{entry['name']}'. Restart the API/commander "
                       f"process to pick them up, then verify in joint-space before trusting "
                       f"Cartesian moves.",
            "profile": entry,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to save DH parameters: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to save DH parameters: {str(e)}")


@app.delete("/api/config/robot/profiles/{profile_id}/dh-params")
async def clear_robot_dh_params(profile_id: str):
    """Clear a custom robot's DH parameters, reverting it to joint-space-only (PAROL6 geometry for Cartesian)."""
    try:
        with open(CONFIG_PATH, "r") as f:
            config = yaml.safe_load(f) or {}
        profiles_cfg = _load_robot_profiles_config(config)

        entry = next((e for e in profiles_cfg["custom"] if e["id"] == profile_id), None)
        if entry is None:
            raise HTTPException(status_code=404, detail=f"Robot profile '{profile_id}' not found")

        entry["dh_params"] = None

        with open(CONFIG_PATH, "w") as f:
            yaml.dump(config, f, default_flow_style=False)

        return {"message": f"DH parameters cleared for '{entry['name']}'", "profile": entry}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to clear DH parameters: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to clear DH parameters: {str(e)}")


@app.delete("/api/config/robot/profiles/{profile_id}")
async def delete_robot_profile(profile_id: str):
    """Remove a custom robot profile and its uploaded files."""
    if profile_id == "parol6":
        raise HTTPException(status_code=400, detail="Cannot delete the built-in PAROL6 profile")
    try:
        with open(CONFIG_PATH, "r") as f:
            config = yaml.safe_load(f) or {}
        profiles_cfg = _load_robot_profiles_config(config)

        if not any(e["id"] == profile_id for e in profiles_cfg["custom"]):
            raise HTTPException(status_code=404, detail=f"Robot profile '{profile_id}' not found")

        profiles_cfg["custom"] = [e for e in profiles_cfg["custom"] if e["id"] != profile_id]
        if profiles_cfg["active"] == profile_id:
            profiles_cfg["active"] = "parol6"
            logger.info(f"Deleted active profile '{profile_id}' - reverted active robot to PAROL6")

        with open(CONFIG_PATH, "w") as f:
            yaml.dump(config, f, default_flow_style=False)

        robot_dir = _custom_robots_root() / profile_id
        if robot_dir.exists() and robot_dir.is_dir() and robot_dir.parent == _custom_robots_root():
            shutil.rmtree(robot_dir)

        return {"message": f"Robot profile '{profile_id}' deleted", "active": profiles_cfg["active"]}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to delete robot profile: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to delete robot profile: {str(e)}")


# Logging Endpoints
@app.get("/api/logs")
async def get_logs(
    level: Optional[str] = Query(None, description="Filter by log level"),
    source: Optional[str] = Query(None, description="Filter by source/module"),
    limit: Optional[int] = Query(100, description="Maximum number of logs", ge=1, le=10000)
):
    """Get recent logs from the buffer"""
    logs = websocket_handler.get_logs(level=level, source=source, limit=limit)
    return {
        "logs": logs,
        "count": len(logs),
        "filters": {
            "level": level,
            "source": source,
            "limit": limit
        }
    }


@app.delete("/api/logs")
async def clear_logs():
    """Clear the log buffer"""
    websocket_handler.clear_logs()
    logger.info("Log buffer cleared")
    return {"message": "Log buffer cleared successfully"}


@app.get("/api/logs/export")
async def export_logs(
    format: Literal["json", "text"] = Query("json", description="Export format")
):
    """Export logs as downloadable file"""
    from fastapi.responses import Response

    try:
        content = websocket_handler.export_logs(format=format)

        if format == "json":
            return Response(
                content=content,
                media_type="application/json",
                headers={"Content-Disposition": f"attachment; filename=robot_logs_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"}
            )
        else:
            return Response(
                content=content,
                media_type="text/plain",
                headers={"Content-Disposition": f"attachment; filename=robot_logs_{datetime.now().strftime('%Y%m%d_%H%M%S')}.txt"}
            )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to export logs: {str(e)}")


# ============================================================================
# Camera Endpoints
# ============================================================================

@app.get("/api/camera/devices")
async def get_camera_devices():
    """Get list of available USB camera devices"""
    try:
        camera_manager = get_camera_manager()
        devices = await asyncio.to_thread(camera_manager.detect_cameras)
        return {
            "devices": devices,
            "count": len(devices)
        }
    except Exception as e:
        logger.error(f"Error detecting cameras: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to detect cameras: {str(e)}")


@app.get("/api/camera/status")
async def get_camera_status():
    """Get current camera status"""
    try:
        camera_manager = get_camera_manager()
        status = camera_manager.get_status()
        return status
    except Exception as e:
        logger.error(f"Error getting camera status: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to get camera status: {str(e)}")


@app.post("/api/camera/start")
async def start_camera(device: str, width: Optional[int] = None, height: Optional[int] = None, fps: Optional[int] = None):
    """
    Start camera on specified device

    Args:
        device: Device path (e.g., /dev/video0)
        width: Optional frame width (default from config)
        height: Optional frame height (default from config)
        fps: Optional frames per second (default from config)
    """
    try:
        camera_manager = get_camera_manager()
        success = await asyncio.to_thread(
            camera_manager.start_camera,
            device,
            width,
            height,
            fps
        )

        if success:
            status = camera_manager.get_status()
            return {
                "success": True,
                "message": f"Camera started on {device}",
                "status": status
            }
        else:
            raise HTTPException(status_code=500, detail=f"Failed to start camera on {device}")

    except Exception as e:
        logger.error(f"Error starting camera: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to start camera: {str(e)}")


@app.post("/api/camera/stop")
async def stop_camera():
    """Stop camera capture"""
    try:
        camera_manager = get_camera_manager()
        await asyncio.to_thread(camera_manager.stop_camera)
        return {
            "success": True,
            "message": "Camera stopped"
        }
    except Exception as e:
        logger.error(f"Error stopping camera: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to stop camera: {str(e)}")


async def generate_mjpeg_stream():
    """Generator function for MJPEG stream"""
    camera_manager = get_camera_manager()

    while True:
        try:
            # Get MJPEG frame from camera manager
            frame = await asyncio.to_thread(camera_manager.get_mjpeg_frame)

            if frame:
                yield frame
            else:
                # Camera not streaming, wait a bit
                await asyncio.sleep(0.1)

        except Exception as e:
            logger.error(f"Error generating MJPEG frame: {e}")
            await asyncio.sleep(0.1)


@app.get("/api/camera/stream")
async def camera_stream():
    """
    MJPEG video stream endpoint

    Returns a continuous multipart MJPEG stream that can be displayed in an img tag:
    <img src="http://localhost:3001/api/camera/stream" />
    """
    return StreamingResponse(
        generate_mjpeg_stream(),
        media_type="multipart/x-mixed-replace; boundary=frame"
    )


# ============================================================================
# Performance Recording Endpoints
# ============================================================================

@app.post("/api/performance/recording/enable", response_model=CommandResponse)
async def enable_performance_recording():
    """
    Arm performance and motion recording.

    When armed, recording auto-starts when first command begins executing
    and auto-stops when command queue is empty. Both performance and motion
    data are captured with shared session names in /recordings/ and /motion_recordings/.
    """
    return execute_robot_command(
        robot_client.set_performance_recording,
        enabled=True,
        wait_for_ack=True,
        timeout=5.0
    )


@app.post("/api/performance/recording/disable", response_model=CommandResponse)
async def disable_performance_recording():
    """
    Disarm recording (and stop if currently recording).

    If recording is active, stops and saves both performance and motion data.
    """
    return execute_robot_command(
        robot_client.set_performance_recording,
        enabled=False,
        wait_for_ack=True,
        timeout=5.0
    )


@app.get("/api/performance/recordings", response_model=list[RecordingListItem])
async def list_performance_recordings():
    """
    List all available performance recordings

    Returns a list of all recording files with summary information including
    filename, timestamp, number of commands, and total duration.
    """
    try:
        recordings_dir = PROJECT_ROOT / "recordings"

        # Create directory if it doesn't exist
        recordings_dir.mkdir(exist_ok=True)

        # Find all JSON files
        recording_files = sorted(recordings_dir.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)

        recordings = []
        for filepath in recording_files:
            try:
                # Read recording metadata
                with open(filepath, 'r') as f:
                    data = json.load(f)

                # Calculate total duration
                total_duration = sum(cmd.get('duration_s', 0) for cmd in data.get('commands', []))

                recordings.append(RecordingListItem(
                    filename=filepath.name,
                    name=data.get('metadata', {}).get('name', filepath.stem),
                    timestamp=data.get('metadata', {}).get('timestamp', ''),
                    num_commands=len(data.get('commands', [])),
                    total_duration_s=total_duration
                ))
            except Exception as e:
                logger.warning(f"Failed to read recording file {filepath.name}: {e}")
                continue

        return recordings

    except Exception as e:
        logger.error(f"Error listing recordings: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to list recordings: {str(e)}")


@app.get("/api/performance/recordings/{filename}", response_model=PerformanceRecording)
async def get_performance_recording(filename: str):
    """
    Get a specific performance recording

    Returns the complete recording data including metadata and all command
    performance samples for visualization and analysis.
    """
    try:
        recordings_dir = PROJECT_ROOT / "recordings"
        filepath = recordings_dir / filename

        # Security: Ensure the path is within recordings directory
        if not filepath.resolve().is_relative_to(recordings_dir.resolve()):
            raise HTTPException(status_code=400, detail="Invalid filename")

        # Check if file exists
        if not filepath.exists():
            raise HTTPException(status_code=404, detail="Recording not found")

        # Read and return recording data
        with open(filepath, 'r') as f:
            data = json.load(f)

        return PerformanceRecording(**data)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error reading recording {filename}: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to read recording: {str(e)}")


@app.delete("/api/performance/recordings/{filename}")
async def delete_performance_recording(filename: str):
    """
    Delete a performance recording

    Permanently deletes the specified recording file.
    """
    try:
        recordings_dir = PROJECT_ROOT / "recordings"
        filepath = recordings_dir / filename

        # Security: Ensure the path is within recordings directory
        if not filepath.resolve().is_relative_to(recordings_dir.resolve()):
            raise HTTPException(status_code=400, detail="Invalid filename")

        # Check if file exists
        if not filepath.exists():
            raise HTTPException(status_code=404, detail="Recording not found")

        # Delete file
        filepath.unlink()

        logger.info(f"Deleted recording: {filename}")
        return {
            "success": True,
            "message": f"Recording {filename} deleted successfully"
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting recording {filename}: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to delete recording: {str(e)}")


# ============================================================================
# Motion Comparison Recording Endpoints
# ============================================================================

# State for tracking motion recording (commander handles all data capture)
motion_recording_state = {
    "is_recording": False,
    "name": None,
    "start_time": None
}


@app.post("/api/motion-recording/start")
async def start_motion_recording(name: str = None):
    """
    Start motion comparison recording.

    Records commanded vs actual joint positions at configurable sample rate
    for debugging motion discrepancies during timeline playback.
    """
    global motion_recording_state

    # Initialize API-side state (tracking only, commander handles all data capture)
    motion_recording_state = {
        "is_recording": True,
        "name": name,
        "start_time": time.time()
    }

    # Start commander-side recording
    result = robot_client.start_motion_recording(name, wait_for_ack=True, timeout=5.0)

    if result and result.get('status') == 'COMPLETED':
        return {"success": True, "message": f"Motion recording started: {name or 'auto'}"}
    else:
        # If commander says "Already recording", sync our state to match
        details = result.get('details', '') if result else ''
        if 'Already recording' in details:
            # Commander is recording but we didn't know - keep our state as recording
            motion_recording_state["is_recording"] = True
            return {"success": True, "message": "Recording already in progress"}
        else:
            motion_recording_state["is_recording"] = False
            return {"success": False, "message": details or 'Failed to start recording'}


@app.post("/api/motion-recording/stop")
async def stop_motion_recording():
    """
    Stop motion comparison recording and save to file.

    Commander handles all data capture (position_out, position_in, commanded targets).
    """
    global motion_recording_state

    if not motion_recording_state["is_recording"]:
        return {"success": False, "message": "No active recording"}

    # Stop commander recording and get data
    result = robot_client.stop_motion_recording(wait_for_ack=True, timeout=10.0)
    logger.debug(f"[MotionRecording] Stop result: {result}")

    if not result or result.get('status') != 'COMPLETED':
        motion_recording_state["is_recording"] = False
        logger.error(f"[MotionRecording] Failed to stop: status={result.get('status') if result else 'None'}, details={result.get('details') if result else 'None'}")
        return {"success": False, "message": "Failed to stop commander recording"}

    # Commander saves file directly and returns metadata only
    try:
        commander_data = json.loads(result.get('details', '{}'))
    except json.JSONDecodeError:
        commander_data = {}

    filename = commander_data.get('filename', 'unknown')
    num_samples = commander_data.get('num_samples', 0)

    logger.info(f"Motion recording saved by commander: {filename} ({num_samples} samples)")

    # Reset state
    motion_recording_state = {
        "is_recording": False,
        "name": None,
        "start_time": None
    }

    return {"success": True, "message": f"Recording saved: {filename}", "filename": filename}


@app.get("/api/motion-recording/status")
async def get_motion_recording_status():
    """Get current motion recording status."""
    commander_status = robot_client.get_motion_recording_status()
    return {
        "is_recording": motion_recording_state["is_recording"],
        "commander_sample_count": commander_status.get("sample_count", 0)
    }


@app.get("/api/motion-recordings")
async def list_motion_recordings():
    """List all available motion comparison recordings."""
    try:
        recordings_dir = PROJECT_ROOT / "motion_recordings"
        recordings_dir.mkdir(exist_ok=True)

        recording_files = sorted(
            recordings_dir.glob("*.json"),
            key=lambda p: p.stat().st_mtime,
            reverse=True
        )

        recordings = []
        for filepath in recording_files:
            try:
                with open(filepath, 'r') as f:
                    data = json.load(f)

                metadata = data.get('metadata', {})
                recordings.append({
                    "filename": filepath.name,
                    "name": metadata.get('name', filepath.stem),
                    "timestamp": metadata.get('timestamp', ''),
                    "duration_s": metadata.get('duration_s', 0),
                    "num_commanded_targets": metadata.get('num_commanded_targets', len(data.get('commanded', []))),
                    "num_samples": metadata.get('num_samples', len(data.get('commander_state', [])))
                })
            except Exception as e:
                logger.warning(f"Failed to read motion recording {filepath.name}: {e}")
                continue

        return recordings

    except Exception as e:
        logger.error(f"Error listing motion recordings: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/motion-recordings/{filename}")
async def get_motion_recording(filename: str):
    """Get a specific motion comparison recording with all samples."""
    recordings_dir = PROJECT_ROOT / "motion_recordings"
    filepath = recordings_dir / filename

    # Security: prevent path traversal
    if not filepath.resolve().is_relative_to(recordings_dir.resolve()):
        raise HTTPException(status_code=400, detail="Invalid filename")

    if not filepath.exists():
        raise HTTPException(status_code=404, detail="Recording not found")

    with open(filepath, 'r') as f:
        return json.load(f)


@app.delete("/api/motion-recordings/{filename}")
async def delete_motion_recording(filename: str):
    """Delete a motion comparison recording."""
    recordings_dir = PROJECT_ROOT / "motion_recordings"
    filepath = recordings_dir / filename

    if not filepath.resolve().is_relative_to(recordings_dir.resolve()):
        raise HTTPException(status_code=400, detail="Invalid filename")

    if not filepath.exists():
        raise HTTPException(status_code=404, detail="Recording not found")

    filepath.unlink()
    logger.info(f"Deleted motion recording: {filename}")
    return {"success": True, "message": f"Deleted {filename}"}


# ============================================================================
# Main Entry Point
# ============================================================================

if __name__ == "__main__":
    import uvicorn
    
    # Get server config
    api_config = config.get('api', {})
    host = api_config.get('host', '0.0.0.0')
    port = api_config.get('port', 8000)
    
    # Run server
    uvicorn.run(
        app,
        host=host,
        port=port,
        log_level="info",
        access_log=True
    )