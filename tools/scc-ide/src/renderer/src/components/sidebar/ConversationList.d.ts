import React from 'react';
interface ConversationListProps {
    activeSessionId: string | null;
    onSelect: (sessionId: string) => void;
    onNewChat: () => void;
}
export default function ConversationList({ activeSessionId, onSelect, onNewChat, }: ConversationListProps): React.ReactElement;
export {};
