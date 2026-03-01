import React from 'react';
import type { Message } from '../../types';
export type { Message };
interface MessageBubbleProps {
    message: Message;
    isStreaming?: boolean;
}
export default function MessageBubble({ message, isStreaming }: MessageBubbleProps): React.ReactElement;
