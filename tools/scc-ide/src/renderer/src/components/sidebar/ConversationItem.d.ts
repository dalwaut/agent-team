import React from 'react';
import type { Conversation } from '../../types';
interface ConversationItemProps {
    conversation: Conversation;
    isActive: boolean;
    onClick: () => void;
    onDelete: () => void;
    onPin: () => void;
}
export default function ConversationItem({ conversation, isActive, onClick, onDelete, onPin, }: ConversationItemProps): React.ReactElement;
export {};
