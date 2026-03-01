import React from 'react';
interface TopBarProps {
    cwd: string;
    onCwdChange: (cwd: string) => void;
    model: string;
    onModelChange: (m: string) => void;
    rightPanelOpen?: boolean;
    onToggleRightPanel?: () => void;
}
export default function TopBar({ cwd, onCwdChange, model, onModelChange, rightPanelOpen, onToggleRightPanel, }: TopBarProps): React.ReactElement;
export {};
