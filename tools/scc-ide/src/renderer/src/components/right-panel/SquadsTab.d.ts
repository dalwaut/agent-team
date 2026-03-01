import React from 'react';
interface SquadsTabProps {
    onRunSquad: (squadId: string, task?: string) => void;
}
export default function SquadsTab({ onRunSquad }: SquadsTabProps): React.ReactElement;
export {};
