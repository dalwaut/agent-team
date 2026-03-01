import React from 'react';
interface ChatAreaProps {
    sessionId?: string | null;
    cwd?: string;
    model?: string;
    onSessionCreated?: (sessionId: string) => void;
}
export default function ChatArea({ sessionId, cwd: cwdProp, model: modelProp, onSessionCreated }: ChatAreaProps): React.ReactElement;
export {};
