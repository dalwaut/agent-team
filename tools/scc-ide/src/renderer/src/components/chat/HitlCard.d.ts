import React from 'react';
interface HitlCardProps {
    action: string;
    path?: string;
    content?: string;
    onApprove: () => void;
    onDeny: () => void;
    onModify?: () => void;
}
export default function HitlCard({ action, path, content, onApprove, onDeny, onModify, }: HitlCardProps): React.ReactElement;
export {};
