@AGENTS.md

## Design

There's no brand guide yet. Until one exists in `design/`, the web app uses shadcn/ui's defaults as the scaffold sets them up. `docs/product.md` decides what the app does; this section governs only how it looks.

- **Tokens:** colours (light and dark), radii, spacing and type come only from CSS variables in the web app's global stylesheet. shadcn generates most of them. The verdict colours shadcn lacks are added there once, as `--verdict-yes`, `--verdict-maybe`, `--verdict-no` and `--verdict-unscreened` (with foreground pairs, in light and dark, each checked for 4.5:1). Never hard-code a hex value or a colour class with a fixed shade in a component.
- **Components:** use shadcn components and their variants before writing new ones. A new component reuses the existing tokens.
- **Visual rules to keep:**
  - every verdict shows colour, icon and word together (Yes, Maybe, No, Not screened);
  - "No" rows are dimmed with a token, not with opacity;
  - one primary button per view;
  - text contrast at least 4.5:1;
  - touch targets on phones at least 44 px.
- **Undrawn cases:** when the design doesn't cover something (an empty or error state, dark mode for a new screen, a new component), reuse existing tokens and patterns, and tell the owner what you decided.
- **Sample data:** Jordan Rivera and invented companies only, in previews, fixtures and screenshots.
- **After each screen:** list every remaining visual difference from the approved layout for that screen, with the reason.
