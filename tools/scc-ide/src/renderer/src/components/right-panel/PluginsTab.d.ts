import React from 'react';
interface PluginsTabProps {
    onInstallPlugin: (command: string) => void;
}
export default function PluginsTab({ onInstallPlugin }: PluginsTabProps): React.ReactElement;
export {};
