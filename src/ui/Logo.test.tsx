import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cwd } from 'node:process';
import { render, screen } from '@testing-library/react';
import { LOGO_HEAD, LOGO_HORN } from './logo';
import { Logo } from './Logo';

// Vitest runs from the repository root.
const file = (path: string) => readFileSync(join(cwd(), path), 'utf8');

describe('logo', () => {
  it.each(['public/favicon.svg', 'docs/images/logo.svg'])('%s holds the same paths as the component', (path) => {
    const svg = file(path);
    expect(svg).toContain(`d="${LOGO_HORN}"`);
    expect(svg).toContain(`d="${LOGO_HEAD}"`);
    expect(svg).toContain('fill-rule="evenodd"'); // the eye is a hole
  });

  it('index.html uses the favicon', () => {
    expect(file('index.html')).toContain('href="/favicon.svg"');
  });

  it('shows the mark and the name; the mark is decorative', () => {
    const { container } = render(<Logo />);
    expect(screen.getByText('RhinoView')).toBeInTheDocument();
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });
});
