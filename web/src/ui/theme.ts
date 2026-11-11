import { createTheme, type MantineColorsTuple } from "@mantine/core";

const nebula: MantineColorsTuple = [
  "#f1ecff", "#ddd4ff", "#b9a6ff", "#9374ff", "#7c5cff", "#6a45fb", "#5f37f9", "#4f2ade", "#4524c7", "#381daf",
];
const plasma: MantineColorsTuple = [
  "#e0fcff", "#cbf3ff", "#9ae6ff", "#64d8ff", "#3ccdfe", "#23c6fe", "#09c2ff", "#00abe4", "#0098cd", "#0084b6",
];
const space: MantineColorsTuple = [
  "#c9d1e8", "#a3adc9", "#7d88a8", "#5a6485", "#3b4463", "#272e48", "#1a2036", "#121729", "#0b0f1d", "#060812",
];

export const theme = createTheme({
  primaryColor: "nebula",
  colors: { nebula, plasma, dark: space },
  fontFamily: "'Inter', 'Segoe UI', system-ui, sans-serif",
  headings: { fontFamily: "'Space Grotesk', 'Inter', system-ui, sans-serif", fontWeight: "600" },
  fontFamilyMonospace: "'JetBrains Mono', ui-monospace, monospace",
  defaultRadius: "md",
  components: {
    Paper: { defaultProps: { withBorder: true } },
    Card: { defaultProps: { withBorder: true } },
  },
});
