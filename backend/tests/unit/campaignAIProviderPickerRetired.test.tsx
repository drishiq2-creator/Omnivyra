/**
 * @jest-environment jsdom
 *
 * e9 ruling 2026-11-13: hide the campaign AI provider picker (the server picks the
 * model) and remove "Demo AI" (canned replies presented as AI) from the customer UI.
 */
import React from 'react';
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { CampaignAIInfoPanels } from '../../../components/campaign-ai/CampaignAIInfoPanels';
import { CAMPAIGN_AI_PROVIDER_KEY, getStoredProvider } from '../../../components/campaign-ai/types';

jest.mock('@/components/shared/EmptyState', () => () => null);
jest.mock('@/components/shared/ExamplePreview', () => () => null);

describe('getStoredProvider', () => {
  afterEach(() => window.localStorage.clear());

  it('maps a previously stored "demo" to the real assistant', () => {
    window.localStorage.setItem(CAMPAIGN_AI_PROVIDER_KEY, 'demo');
    expect(getStoredProvider()).toBe('claude');
  });

  it('keeps gpt / claude, defaults to claude', () => {
    window.localStorage.setItem(CAMPAIGN_AI_PROVIDER_KEY, 'gpt');
    expect(getStoredProvider()).toBe('gpt');
    window.localStorage.setItem(CAMPAIGN_AI_PROVIDER_KEY, 'claude');
    expect(getStoredProvider()).toBe('claude');
    window.localStorage.removeItem(CAMPAIGN_AI_PROVIDER_KEY);
    expect(getStoredProvider()).toBe('claude');
  });
});

describe('CampaignAIInfoPanels', () => {
  it('never renders the AI provider picker, even when asked to show settings', () => {
    render(
      <CampaignAIInfoPanels
        showLearning={false}
        showSettings
        campaignLearnings={[]}
        selectedProvider="claude"
        onProviderChange={() => {}}
      />,
    );
    expect(screen.queryByText('AI Provider')).not.toBeInTheDocument();
    expect(screen.queryByText('Demo AI')).not.toBeInTheDocument();
    expect(screen.queryByText(/simulated responses/i)).not.toBeInTheDocument();
  });

  it('still renders campaign learnings', () => {
    render(
      <CampaignAIInfoPanels
        showLearning
        campaignLearnings={[{ campaignName: 'Spring', learnings: ['Short hooks win'] } as any]}
      />,
    );
    expect(screen.getByText(/Campaign Learnings \(1\)/)).toBeInTheDocument();
    expect(screen.getByText(/Short hooks win/)).toBeInTheDocument();
  });
});

describe('CampaignAIChatShell has no settings button', () => {
  it('does not render a toggle for the retired settings panel', () => {
    const src = require('fs').readFileSync(
      require('path').join(process.cwd(), 'components/campaign-ai/CampaignAIChatShell.tsx'),
      'utf8',
    ) as string;
    expect(src).not.toMatch(/setShowSettings\(/);
    expect(src).not.toMatch(/<Settings\b/);
  });
});

describe('the fake-AI surfaces are RETIRED, not hidden (b3 2026-11-19; public repo)', () => {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const at = (p: string) => path.join(process.cwd(), p);
  const read = (p: string) => fs.readFileSync(at(p), 'utf8');

  it("'demo' is gone from the AIProvider union (the type-level source of every demo branch)", () => {
    const union = /export type AIProvider = ([^;]+);/.exec(read('components/campaign-ai/types.ts'));
    expect(union).not.toBeNull();
    expect(union![1]).not.toMatch(/'demo'/);
    expect(union![1]).toMatch(/'claude'/); // control: the union is still the one we mean
  });

  it.each([
    'components/campaign-ai/demoResponses.ts',
    'components/GPTAIChat.tsx',
    'components/MultiAIChat.tsx',
    'components/ComprehensivePlanningInterface.tsx',
    'lib/campaign-details/useWeeklyAiActions.ts',
  ])('%s is deleted', (file) => {
    expect(fs.existsSync(at(file))).toBe(false);
  });
  it('control: the existence check sees a file that exists', () => {
    expect(fs.existsSync(at('components/campaign-ai/types.ts'))).toBe(true);
  });

  it('nothing in the client calls a canned-reply generator, branches on, or SENDS a demo provider', () => {
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const n of fs.readdirSync(at(d))) {
        const rel = `${d}/${n}`;
        if (rel.startsWith('pages/api') || n === 'node_modules') continue;
        const st = fs.statSync(at(rel));
        if (st.isDirectory()) walk(rel);
        else if (/\.(ts|tsx)$/.test(n) && /generateDemoResponse|demoResponses|=== 'demo'|provider: 'demo'/.test(read(rel))) hits.push(rel);
      }
    };
    ['components', 'hooks', 'lib', 'pages'].forEach(walk);
    expect(hits).toEqual([]);
  });

  it('useComprehensivePlan is TYPES only (its hook defaulted to the demo provider and lost its only caller)', () => {
    const src = read('hooks/useComprehensivePlan.ts');
    expect(src).not.toMatch(/export function useComprehensivePlan/);
    expect(src).not.toMatch(/'demo'/);
    expect(src).toMatch(/export interface CampaignStrategy/); // control: the types are still here
  });

  it('the blueprint-failure fallback sends no provider and reports what was ACTUALLY created', () => {
    const src = read('hooks/useCampaignDetailsHandlers.tsx');
    expect(src).not.toMatch(/provider: 'demo'/);
    expect(src).not.toMatch(/Generated 7 daily plans/);
    expect(src).toMatch(/fb\?\.rowsInserted/);
    expect(src).toMatch(/couldn't be built, so we created \$\{created\} simpler daily plan/);
  });
});

