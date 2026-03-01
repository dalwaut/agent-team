import React from 'react';
interface ToolCallCardProps {
    toolName: string;
    input: Record<string, unknown>;
    isResult?: boolean;
    result?: string;
    isError?: boolean;
}
export default function ToolCallCard({ toolName, input, isResult, result, isError, }: ToolCallCardProps): React.ReactElement;
export {};
