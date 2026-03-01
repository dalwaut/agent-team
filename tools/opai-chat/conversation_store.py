"""OPAI Chat - Conversation storage (JSON-based)."""

import json
from pathlib import Path
from typing import List, Optional
from datetime import datetime
from models import Conversation, ConversationSummary, Message
import config


class ConversationStore:
    """Manages conversation persistence using JSON files."""
    
    def __init__(self):
        self.conversations_dir = config.CONVERSATIONS_DIR
    
    def _get_conversation_path(self, conversation_id: str) -> Path:
        """Get the file path for a conversation."""
        return self.conversations_dir / f"{conversation_id}.json"
    
    def list_conversations(self, user_id: str = None) -> List[ConversationSummary]:
        """List conversations with summaries, optionally filtered by user_id."""
        summaries = []

        for conv_file in self.conversations_dir.glob("*.json"):
            try:
                with open(conv_file, 'r') as f:
                    data = json.load(f)

                # Filter by user_id if specified
                if user_id and data.get("user_id") and data["user_id"] != user_id:
                    continue

                # Generate preview from last message
                preview = ""
                if data.get("messages"):
                    last_msg = data["messages"][-1]
                    content = last_msg.get("content", "")
                    preview = content[:100] + ("..." if len(content) > 100 else "")

                summaries.append(ConversationSummary(
                    id=data["id"],
                    title=data["title"],
                    updated_at=data["updated_at"],
                    preview=preview,
                    model=data.get("model", config.DEFAULT_MODEL)
                ))
            except Exception as e:
                print(f"Error loading conversation {conv_file}: {e}")
                continue

        # Sort by updated_at descending
        summaries.sort(key=lambda x: x.updated_at, reverse=True)
        return summaries
    
    def get_conversation(self, conversation_id: str) -> Optional[Conversation]:
        """Get a full conversation by ID."""
        conv_path = self._get_conversation_path(conversation_id)
        
        if not conv_path.exists():
            return None
        
        try:
            with open(conv_path, 'r') as f:
                data = json.load(f)
                return Conversation(**data)
        except Exception as e:
            print(f"Error loading conversation {conversation_id}: {e}")
            return None
    
    def create_conversation(self, title: str = "New Chat", model: str = None,
                            user_id: str = None) -> Conversation:
        """Create a new conversation."""
        if model is None:
            model = config.DEFAULT_MODEL

        # Generate ID with timestamp
        timestamp = datetime.utcnow()
        conv_id = f"conv_{timestamp.strftime('%Y%m%d_%H%M%S')}_{id(timestamp) % 10000:04x}"

        conversation = Conversation(
            id=conv_id,
            title=title,
            created_at=timestamp.isoformat() + "Z",
            updated_at=timestamp.isoformat() + "Z",
            model=model,
            messages=[],
            user_id=user_id,
        )

        self.save_conversation(conversation)
        return conversation
    
    def save_conversation(self, conversation: Conversation) -> None:
        """Save a conversation to disk."""
        conv_path = self._get_conversation_path(conversation.id)
        
        # Update timestamp
        conversation.updated_at = datetime.utcnow().isoformat() + "Z"
        
        try:
            with open(conv_path, 'w') as f:
                json.dump(conversation.model_dump(), f, indent=2)
        except Exception as e:
            print(f"Error saving conversation {conversation.id}: {e}")
            raise
    
    def update_conversation(self, conversation_id: str, title: str = None, 
                          model: str = None, tags: List[str] = None) -> Optional[Conversation]:
        """Update conversation metadata."""
        conversation = self.get_conversation(conversation_id)
        
        if not conversation:
            return None
        
        if title is not None:
            conversation.title = title
        if model is not None:
            conversation.model = model
        if tags is not None:
            conversation.tags = tags
        
        self.save_conversation(conversation)
        return conversation
    
    def delete_conversation(self, conversation_id: str) -> bool:
        """Delete a conversation."""
        conv_path = self._get_conversation_path(conversation_id)
        
        if not conv_path.exists():
            return False
        
        try:
            conv_path.unlink()
            return True
        except Exception as e:
            print(f"Error deleting conversation {conversation_id}: {e}")
            return False
    
    def add_message(self, conversation_id: str, message: Message) -> Optional[Conversation]:
        """Add a message to a conversation."""
        conversation = self.get_conversation(conversation_id)
        
        if not conversation:
            return None
        
        conversation.messages.append(message)
        self.save_conversation(conversation)
        return conversation


# Global instance
store = ConversationStore()
