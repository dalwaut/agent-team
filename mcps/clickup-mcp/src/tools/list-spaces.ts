/**
 * list_spaces — List all ClickUp spaces in the team.
 */
import { cuGet, getTeamId } from '../clickup-api.js';

export const LIST_SPACES_TOOL = {
    name: 'clickup_list_spaces',
    description: 'List all spaces in the ClickUp team. Returns space ID, name, and status info.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            include_archived: {
                type: 'boolean',
                description: 'Include archived spaces (default: false)',
                default: false,
            },
        },
    },
};

export async function handleListSpaces(args: { include_archived?: boolean }) {
    const teamId = getTeamId();
    const data = await cuGet(`/team/${teamId}/space`, {
        archived: args.include_archived ? 'true' : 'false',
    });
    const spaces = (data.spaces || []).map((s: any) => ({
        id: s.id,
        name: s.name,
        color: s.color,
        private: s.private,
        statuses: (s.statuses || []).map((st: any) => st.status),
        member_count: (s.members || []).length,
    }));
    return { count: spaces.length, spaces };
}
