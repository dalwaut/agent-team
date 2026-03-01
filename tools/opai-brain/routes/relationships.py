"""2nd Brain — Relationship Intelligence routes (Phase 8.1).

Dedicated endpoints for typed relationship CRUD and graph analytics.
Keeps graph.py and canvas.py clean.
"""
from __future__ import annotations

import logging
import sys
from pathlib import Path
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).parent.parent.parent / "shared"))
from auth import AuthUser, get_current_user

import config

log = logging.getLogger("brain.routes.relationships")
router = APIRouter()


def _svc_headers() -> dict:
    return {
        "apikey": config.SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {config.SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


async def _sb_get(path: str, params: str = "") -> list:
    url = f"{config.SUPABASE_URL}/rest/v1/{path}{('?' + params) if params else ''}"
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.get(url, headers=_svc_headers())
        r.raise_for_status()
        return r.json()


async def _sb_post(path: str, body) -> dict:
    url = f"{config.SUPABASE_URL}/rest/v1/{path}"
    async with httpx.AsyncClient(timeout=15) as c:
        r = await c.post(url, headers=_svc_headers(), json=body)
        r.raise_for_status()
        rows = r.json()
        return rows[0] if isinstance(rows, list) and rows else rows


# ── Models ────────────────────────────────────────────────────────────────────

class RelationshipCreate(BaseModel):
    source_id: str
    target_id: str
    link_type: str = "related"
    label: Optional[str] = ""
    strength: float = 0.7


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("/api/relationships/{node_id}")
async def get_relationships(node_id: str, user: AuthUser = Depends(get_current_user)):
    """All links for a node (both as source and target), enriched with target node info."""
    # Links where this node is source
    outgoing = await _sb_get(
        "brain_links",
        f"user_id=eq.{user.id}&source_id=eq.{node_id}"
        f"&select=id,source_id,target_id,link_type,label,strength,created_by,created_at",
    )
    # Links where this node is target
    incoming = await _sb_get(
        "brain_links",
        f"user_id=eq.{user.id}&target_id=eq.{node_id}"
        f"&select=id,source_id,target_id,link_type,label,strength,created_by,created_at",
    )

    all_links = outgoing + incoming

    # Collect all peer node IDs for enrichment
    peer_ids = set()
    for lk in all_links:
        peer_ids.add(lk["source_id"] if lk["source_id"] != node_id else lk["target_id"])

    # Fetch peer node titles/types
    peer_map = {}
    if peer_ids:
        peers = await _sb_get(
            "brain_nodes",
            f"id=in.({','.join(peer_ids)})&select=id,title,type",
        )
        peer_map = {p["id"]: p for p in peers}

    # Enrich links with peer info
    enriched = []
    for lk in all_links:
        peer_id = lk["source_id"] if lk["source_id"] != node_id else lk["target_id"]
        peer = peer_map.get(peer_id, {})
        enriched.append({
            **lk,
            "direction": "outgoing" if lk["source_id"] == node_id else "incoming",
            "peer_id": peer_id,
            "peer_title": peer.get("title", "Untitled"),
            "peer_type": peer.get("type", "note"),
        })

    # Group counts by type
    type_counts = {}
    for lk in enriched:
        t = lk.get("link_type", "related")
        type_counts[t] = type_counts.get(t, 0) + 1

    return {
        "relationships": enriched,
        "total": len(enriched),
        "type_counts": type_counts,
    }


@router.post("/api/relationships")
async def create_relationship(body: RelationshipCreate, user: AuthUser = Depends(get_current_user)):
    """Create a typed relationship between two nodes."""
    if body.source_id == body.target_id:
        raise HTTPException(400, "Cannot link a node to itself")

    # Verify both nodes belong to user
    src = await _sb_get("brain_nodes", f"id=eq.{body.source_id}&user_id=eq.{user.id}&select=id")
    tgt = await _sb_get("brain_nodes", f"id=eq.{body.target_id}&user_id=eq.{user.id}&select=id")
    if not src:
        raise HTTPException(404, "Source node not found")
    if not tgt:
        raise HTTPException(404, "Target node not found")

    # Prevent duplicate edges (same source, target, and type)
    existing = await _sb_get(
        "brain_links",
        f"user_id=eq.{user.id}&source_id=eq.{body.source_id}"
        f"&target_id=eq.{body.target_id}&link_type=eq.{body.link_type}&select=id",
    )
    if existing:
        return existing[0]

    strength = max(0.0, min(1.0, body.strength))
    link = await _sb_post("brain_links", {
        "user_id": user.id,
        "source_id": body.source_id,
        "target_id": body.target_id,
        "link_type": body.link_type,
        "label": body.label or "",
        "strength": strength,
        "created_by": "user",
    })
    return link


@router.get("/api/graph/stats")
async def get_graph_stats(user: AuthUser = Depends(get_current_user)):
    """Graph analytics: orphans, dead-ends, clusters, bridge nodes."""
    nodes = await _sb_get(
        "brain_nodes",
        f"user_id=eq.{user.id}&type=neq.inbox&select=id",
    )
    links = await _sb_get(
        "brain_links",
        f"user_id=eq.{user.id}&select=source_id,target_id",
    )

    node_ids = {n["id"] for n in nodes}

    # Build adjacency (undirected for cluster detection)
    adj: dict[str, set[str]] = {nid: set() for nid in node_ids}
    outgoing: dict[str, int] = {nid: 0 for nid in node_ids}
    incoming: dict[str, int] = {nid: 0 for nid in node_ids}

    for lk in links:
        s, t = lk["source_id"], lk["target_id"]
        if s in node_ids and t in node_ids:
            adj[s].add(t)
            adj[t].add(s)
            outgoing[s] = outgoing.get(s, 0) + 1
            incoming[t] = incoming.get(t, 0) + 1

    # Orphans: no connections at all
    orphans = [nid for nid in node_ids if not adj[nid]]

    # Dead-ends: has outgoing but no incoming
    dead_ends = [nid for nid in node_ids if outgoing.get(nid, 0) > 0 and incoming.get(nid, 0) == 0]

    # Connected components (clusters) via BFS
    visited = set()
    clusters = 0
    for nid in node_ids:
        if nid in visited or nid in orphans:
            continue
        if not adj[nid]:
            continue
        clusters += 1
        queue = [nid]
        while queue:
            current = queue.pop(0)
            if current in visited:
                continue
            visited.add(current)
            for neighbor in adj[current]:
                if neighbor not in visited:
                    queue.append(neighbor)

    # Bridge nodes: removing them would increase cluster count
    # (simplified: nodes connected to 2+ different clusters)
    bridge_nodes = []
    for nid in node_ids:
        if len(adj[nid]) >= 2:
            neighbor_groups = set()
            for nb in adj[nid]:
                neighbor_groups.add(frozenset(adj[nb] - {nid}))
            if len(neighbor_groups) >= 2:
                bridge_nodes.append(nid)

    return {
        "total_nodes": len(node_ids),
        "total_links": len(links),
        "orphan_count": len(orphans),
        "dead_end_count": len(dead_ends),
        "cluster_count": clusters,
        "bridge_node_count": len(bridge_nodes),
        "orphan_ids": orphans[:20],
        "dead_end_ids": dead_ends[:20],
    }
