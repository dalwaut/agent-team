"""OPAI Chat - Data models."""

from typing import List, Optional, Dict, Any, Literal
from pydantic import BaseModel, Field
from datetime import datetime


class ContextReference(BaseModel):
    """Reference to attached context (file, OPAI data, etc.)."""
    type: Literal["file", "opai_context", "canvas"]
    path: Optional[str] = None
    label: str
    content: Optional[str] = None


class ToolCall(BaseModel):
    """Tool call made by the assistant."""
    id: str
    name: str
    input: Dict[str, Any]
    result: Optional[str] = None
    status: Literal["pending", "approved", "denied", "executed"] = "pending"


class CanvasItem(BaseModel):
    """Canvas item (code block, artifact)."""
    id: str
    type: Literal["code", "html", "text"]
    language: str
    filename: Optional[str] = None
    content: str


class Message(BaseModel):
    """Chat message."""
    id: str
    role: Literal["user", "assistant"]
    content: str
    timestamp: str
    model: Optional[str] = None  # Which model generated this (for assistant messages)
    context_refs: List[ContextReference] = Field(default_factory=list)
    tool_calls: List[ToolCall] = Field(default_factory=list)
    canvas_items: List[CanvasItem] = Field(default_factory=list)
    usage: Optional[Dict[str, int]] = None  # Token usage


class Conversation(BaseModel):
    """Full conversation with messages."""
    id: str
    title: str
    created_at: str
    updated_at: str
    model: str  # Currently selected model
    messages: List[Message] = Field(default_factory=list)
    tags: List[str] = Field(default_factory=list)
    user_id: Optional[str] = None  # Supabase user UUID for multi-user isolation


class ConversationSummary(BaseModel):
    """Lightweight conversation summary for list view."""
    id: str
    title: str
    updated_at: str
    preview: str  # First few words of last message
    model: str


class ChatRequest(BaseModel):
    """Request to send a chat message."""
    conversation_id: str
    message: str
    model: str
    context_refs: List[ContextReference] = Field(default_factory=list)


class ToolApprovalRequest(BaseModel):
    """Request to approve/deny a tool call."""
    conversation_id: str
    message_id: str
    tool_call_id: str
    approved: bool
