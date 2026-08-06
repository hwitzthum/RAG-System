import { expect, type Locator } from "@playwright/test";

/**
 * Layout guards for the fixed-width rails.
 *
 * The 280px and 320px rails are where this UI breaks first, and the failures
 * are invisible to ordinary assertions: a control pushed outside its rail is
 * still in the DOM, still `toBeVisible()` (non-empty box, not display:none),
 * and still clickable — Playwright just scrolls the overflowing container to
 * reach it. Only its geometry is wrong.
 *
 * Two regressions of exactly this shape shipped: a `.seam-grid` column sizing
 * to its widest item and pushing row controls out of the rail, and tracked-caps
 * button labels wrapping out of their tile. Both passed a green suite.
 */

/** Tags whose content is meant to scroll horizontally; not layout defects. */
const SELF_SCROLLING_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT", "PRE"]);

type Overflow = { element: string; overflowPx: number };

/**
 * Asserts that neither `root` nor any descendant overflows horizontally.
 *
 * Note this deliberately does not exempt `overflow-x: auto` containers. A
 * vertical-only scroll list (`overflow-y-auto`) computes `overflow-x` to
 * `auto` as well, so exempting it would skip precisely the containers that
 * broke.
 */
export async function expectNoHorizontalOverflow(
  root: Locator,
  label: string,
): Promise<void> {
  const offenders = await root.evaluate(
    (el, selfScrolling: string[]) => {
      const skip = new Set(selfScrolling);
      const found: Overflow[] = [];

      const inspect = (node: Element) => {
        if (skip.has(node.tagName)) return;
        // Inline elements report clientWidth 0; they cannot overflow a box.
        if (node.clientWidth === 0) return;

        // Deliberate truncation (Tailwind's `truncate`) clips text with an
        // ellipsis inside a correctly-sized box. It reports scrollWidth >
        // clientWidth by design and cannot push a sibling anywhere.
        // Containers with plain `overflow: hidden` are NOT exempt — one
        // silently swallowing a control is exactly the defect worth surfacing.
        if (getComputedStyle(node).textOverflow === "ellipsis") return;

        const overflowPx = node.scrollWidth - node.clientWidth;
        if (overflowPx <= 1) return;

        const className =
          typeof node.className === "string" ? node.className : "";
        const descriptor = className
          ? `${node.tagName.toLowerCase()}.${className.trim().split(/\s+/).slice(0, 4).join(".")}`
          : node.tagName.toLowerCase();
        found.push({ element: descriptor, overflowPx });
      };

      inspect(el);
      el.querySelectorAll("*").forEach(inspect);
      return found;
    },
    [...SELF_SCROLLING_TAGS],
  );

  expect(
    offenders,
    `${label}: ${offenders.length} element(s) overflow horizontally — content is wider than the rail, so trailing controls are pushed out of view:\n` +
      offenders.map((o) => `  · ${o.element} (+${o.overflowPx}px)`).join("\n"),
  ).toEqual([]);
}

/**
 * Asserts no button inside `root` has wrapped its label onto a second line.
 *
 * Tracked-caps labels are wide, and a wrapped one grows the button box until
 * it spills over its tile's border. `expectNoHorizontalOverflow` cannot see
 * this: `scrollWidth` does not reflect a child escaping a non-scrollable
 * parent, so the wrap is invisible to it. Line count is the direct signal.
 */
export async function expectNoWrappedButtons(
  root: Locator,
  label: string,
): Promise<void> {
  const wrapped = await root.evaluate((el) => {
    const found: { element: string; lines: number }[] = [];

    el.querySelectorAll("button").forEach((button) => {
      if (button.clientHeight === 0 || !button.textContent?.trim()) return;

      const style = getComputedStyle(button);
      const lineHeight =
        style.lineHeight === "normal"
          ? parseFloat(style.fontSize) * 1.2
          : parseFloat(style.lineHeight);
      if (!Number.isFinite(lineHeight) || lineHeight <= 0) return;

      const contentHeight =
        button.clientHeight -
        parseFloat(style.paddingTop) -
        parseFloat(style.paddingBottom);
      const lines = Math.round(contentHeight / lineHeight);
      if (lines > 1) {
        found.push({ element: `"${button.textContent.trim()}"`, lines });
      }
    });

    return found;
  });

  expect(
    wrapped,
    `${label}: ${wrapped.length} button label(s) wrapped onto multiple lines — the button box grows and spills out of its container:\n` +
      wrapped.map((w) => `  · ${w.element} (${w.lines} lines)`).join("\n"),
  ).toEqual([]);
}

/**
 * Asserts `child` sits inside `container` horizontally.
 *
 * Deliberately avoids `scrollIntoViewIfNeeded()`: that scrolls the rail
 * horizontally to bring the control into view, which is the symptom under
 * test. The row is brought into view vertically, then every horizontal scroll
 * offset is reset before measuring.
 */
export async function expectHorizontallyInside(
  child: Locator,
  container: Locator,
  label: string,
): Promise<void> {
  await child.evaluate((el) =>
    el.scrollIntoView({ block: "nearest", inline: "nearest" }),
  );
  await container.evaluate((el) => {
    el.scrollLeft = 0;
    el.querySelectorAll("*").forEach((node) => {
      (node as HTMLElement).scrollLeft = 0;
    });
  });

  const childBox = await child.boundingBox();
  const containerBox = await container.boundingBox();

  expect(childBox, `${label}: no bounding box`).not.toBeNull();
  expect(
    containerBox,
    `${label}: container has no bounding box`,
  ).not.toBeNull();

  const childRight = childBox!.x + childBox!.width;
  const containerRight = containerBox!.x + containerBox!.width;

  expect(
    childRight,
    `${label} overflows its container (right edge ${Math.round(childRight)}px vs container ${Math.round(containerRight)}px) — the control has been pushed out of view`,
  ).toBeLessThanOrEqual(containerRight);
  expect(
    childBox!.x,
    `${label} starts left of its container`,
  ).toBeGreaterThanOrEqual(containerBox!.x);
}
