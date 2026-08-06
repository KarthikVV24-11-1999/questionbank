import axe from 'axe-core';

/**
 * Runs the automated WCAG 2.2 AA scan the CI gate runs (FRONTEND §10). It
 * catches the machine-checkable subset only; keyboard and screen-reader
 * behaviour still need their own assertions.
 */
export async function accessibilityViolations(container: HTMLElement): Promise<string[]> {
  const results = await axe.run(container, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
  });

  return results.violations.map(
    (violation) => `${violation.id}: ${violation.help} (${violation.nodes.length} node(s))`,
  );
}
