"use client";
import { Badge, Box, NavLink, ScrollArea, Stack, Text } from "@mantine/core";
import {
  IconBolt,
  IconBook,
  IconBooks,
  IconBulb,
  IconBox,
  IconBrain,
  IconCloudDownload,
  IconFileDescription,
  IconFolderCode,
  IconGitBranch,
  IconLayoutList,
  IconPlugConnected,
  IconRobot,
  IconRoute,
  IconMessages,
  type Icon,
} from "@tabler/icons-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { BrowsableKind } from "@/core/ports/app.ts";
import { useLive } from "./api.ts";

interface Entry {
  label: string;
  href: string;
  icon: Icon;
  kind?: string;
}

/** Kept deliberately small (U1). Refresh actions (e.g. re-sync a repository) will hang off these entries later. */
const SECTIONS: { title: string; entries: Entry[] }[] = [
  {
    title: "Work",
    entries: [
      { label: "Work items", href: "/", icon: IconLayoutList, kind: "WorkItem" },
      { label: "Agent chats", href: "/chats", icon: IconMessages },
      { label: "Workspaces", href: "/resources/workspaces", icon: IconGitBranch, kind: "Workspace" },
      { label: "Agent runs", href: "/resources/agentruns", icon: IconBolt, kind: "AgentRun" },
      { label: "Knowledge", href: "/knowledge", icon: IconBulb, kind: "KnowledgeEntry" },
    ],
  },
  {
    title: "Definitions",
    entries: [
      { label: "Workflows", href: "/resources/workflows", icon: IconRoute, kind: "Workflow" },
      { label: "Agents", href: "/resources/agents", icon: IconRobot, kind: "Agent" },
      { label: "Skills", href: "/resources/skills", icon: IconBook, kind: "Skill" },
      { label: "Artifact types", href: "/resources/artifacttypes", icon: IconFileDescription, kind: "ArtifactType" },
    ],
  },
  {
    title: "Integrations",
    entries: [
      { label: "Repositories", href: "/resources/repositories", icon: IconFolderCode, kind: "Repository" },
      { label: "Sources", href: "/resources/sources", icon: IconCloudDownload, kind: "Source" },
      { label: "Model providers", href: "/resources/modelproviders", icon: IconBrain, kind: "ModelProvider" },
      { label: "Sandbox profiles", href: "/resources/sandboxprofiles", icon: IconBox, kind: "SandboxProfile" },
      { label: "Knowledge sources", href: "/resources/knowledgesources", icon: IconBooks, kind: "KnowledgeSource" },
      { label: "Tool servers (MCP)", href: "/resources/toolservers", icon: IconPlugConnected, kind: "ToolServer" },
    ],
  },
];

export function Navbar() {
  const path = usePathname();
  const { data } = useLive<BrowsableKind[]>("/api/resources", (n) => n.type === "ADDED" || n.type === "DELETED");
  const count = (kind?: string) => data?.find((k) => k.kind === kind)?.count;
  const active = (href: string) => (href === "/" ? path === "/" || path.startsWith("/items") : path.startsWith(href));
  return (
    <ScrollArea h="100%" px="xs" py="md">
      <Stack gap="md">
        {SECTIONS.map((s) => (
          <Box key={s.title}>
            <Text size="xs" fw={600} c="dimmed" tt="uppercase" px="sm" mb={4}>
              {s.title}
            </Text>
            {s.entries.map((e) => (
              <NavLink
                key={e.href}
                component={Link}
                href={e.href}
                label={e.label}
                active={active(e.href)}
                leftSection={<e.icon size={16} stroke={1.6} />}
                rightSection={
                  count(e.kind) !== undefined ? (
                    <Badge size="xs" variant="light" color="gray" radius="sm">
                      {count(e.kind)}
                    </Badge>
                  ) : null
                }
                styles={{ root: { borderRadius: 6 } }}
              />
            ))}
          </Box>
        ))}
      </Stack>
    </ScrollArea>
  );
}
