import { createTheme, type MantineColorsTuple } from "@mantine/core";

/** ADR-0018: clean, neutral theme with a single blue/indigo accent. */
const brand: MantineColorsTuple = [
  "#eef3ff", "#dce4f5", "#b9c7e2", "#94a8d0", "#748dc0", "#5f7cb7", "#5474b4", "#44639f", "#3a5890", "#2c4b80",
];

export const theme = createTheme({
  primaryColor: "indigo",
  primaryShade: { light: 6, dark: 5 },
  colors: { brand },
  fontFamily: "Inter, -apple-system, 'Segoe UI', system-ui, sans-serif",
  fontFamilyMonospace: "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace",
  headings: { fontFamily: "Inter, -apple-system, 'Segoe UI', system-ui, sans-serif", fontWeight: "600" },
  defaultRadius: "sm",
  cursorType: "pointer",
  components: {
    Card: { defaultProps: { withBorder: true, shadow: "none", radius: "md" } },
    Paper: { defaultProps: { withBorder: true, shadow: "none" } },
    Badge: { defaultProps: { radius: "sm", fw: 500, tt: "none" } },
    Button: { defaultProps: { radius: "sm" } },
    Table: { defaultProps: { highlightOnHover: true } },
  },
});
