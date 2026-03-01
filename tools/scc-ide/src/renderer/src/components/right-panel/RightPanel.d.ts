import React from 'react';
interface RightPanelProps {
    onInstallPlugin: (command: string) => void;
    onRunSquad: (squadId: string, task?: string) => void;
    cwd?: string;
}
export default function RightPanel({ onInstallPlugin, onRunSquad, cwd, }: RightPanelProps): React.ReactElement;
export {};
