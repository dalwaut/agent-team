/**
 * get_members — List all members in the ClickUp team.
 */
import { cuGet, getTeamId } from '../clickup-api.js';

export const GET_MEMBERS_TOOL = {
    name: 'clickup_get_members',
    description: 'List all members in the ClickUp team/workspace with their roles and contact info.',
    inputSchema: {
        type: 'object' as const,
        properties: {},
    },
};

export async function handleGetMembers() {
    const teamId = getTeamId();
    const data = await cuGet(`/team/${teamId}`);
    const team = data.team || data;

    const members = (team.members || []).map((m: any) => {
        const user = m.user || m;
        return {
            id: user.id,
            username: user.username,
            email: user.email,
            role: user.role,
            initials: user.initials,
        };
    });

    return {
        team_name: team.name,
        member_count: members.length,
        members,
    };
}
