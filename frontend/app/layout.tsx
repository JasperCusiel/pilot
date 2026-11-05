'use client';

import "./globals.css";
import WebSocketConnector from './components/WebSocketConnector';
import RobotProfileLoader from './components/RobotProfileLoader';

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Light theme by default (previously hardcoded to "dark" - see AUDIT.md).
  // The .dark styles in globals.css are still there if you want to add a
  // theme toggle later; this just stops forcing it on.
  return (
    <html lang="en">
      <head>
        <title>PAROL6 Control</title>
        <link href="https://fonts.googleapis.com/icon?family=Material+Icons&display=block" rel="stylesheet" />
        <link href="https://fonts.googleapis.com/css2?family=Patrick+Hand&display=swap" rel="stylesheet" />
        <link href="https://fonts.googleapis.com/css2?family=Noto+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
      </head>
      <body className="antialiased font-sans">
        {/* Global WebSocket connection - updates Zustand store on all pages */}
        <WebSocketConnector />
        {/* Loads the active robot profile (PAROL6 or a custom upload) once on boot */}
        <RobotProfileLoader />
        {children}
      </body>
    </html>
  );
}
