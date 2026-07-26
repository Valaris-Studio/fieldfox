import { useState } from 'react';
import * as Select from '@radix-ui/react-select';
import * as Switch from '@radix-ui/react-switch';
// Side effect only: registers the <field-fox> custom element (this route mounts
// without App.tsx, so it cannot rely on that module's import).
import '@fieldfox/widget';

// The high-fidelity half of the driver test surface (card fd743951,
// RESEARCH §9.11). The hand-rolled fixture in examples/plain-html proves the
// drivers work against the pure ARIA contract; THIS form proves they survive
// what a real design system actually does — Radix portals its listbox to the
// body, applies `hideOthers` (aria-hidden on the rest of the page) while a
// Select is open, and mirrors state into a hidden native input whose value
// lands a tick late (radix-ui#3521). None of that can be faked by hand.
//
// Deliberately a SEPARATE form with its own <field-fox>: the profile form is
// the framework-matrix fixture and its selectors are a test contract.

const REGIONS = [
  { value: 'sa-east-1', label: 'São Paulo' },
  { value: 'us-west-2', label: 'Oregon' },
  { value: 'eu-central-1', label: 'Frankfurt' },
];

const TIERS = [
  { value: 'bronze', label: 'Bronze' },
  { value: 'silver', label: 'Silver' },
  { value: 'gold', label: 'Gold' },
];

export function RadixForm() {
  const [region, setRegion] = useState('');
  const [tier, setTier] = useState('');
  const [backups, setBackups] = useState(false);

  return (
    <main id="radix-section">
      <h1>Deployment request (Radix)</h1>
      <p className="muted">
        Real Radix Select + Switch — portalled listbox, no native control behind the trigger.
      </p>

      <div id="radix-form">
        <label htmlFor="radix-project">Project name</label>
        <input id="radix-project" name="radix-project" type="text" />

        <span className="field-label" id="radix-region-label">
          Region
        </span>
        <Select.Root value={region} onValueChange={setRegion}>
          <Select.Trigger id="radix-region" name="region" aria-labelledby="radix-region-label">
            <Select.Value placeholder="Select a region" />
          </Select.Trigger>
          <Select.Portal>
            <Select.Content>
              <Select.Viewport>
                {REGIONS.map((option) => (
                  <Select.Item key={option.value} value={option.value}>
                    <Select.ItemText>{option.label}</Select.ItemText>
                  </Select.Item>
                ))}
              </Select.Viewport>
            </Select.Content>
          </Select.Portal>
        </Select.Root>

        <span className="field-label" id="radix-tier-label">
          Support tier
        </span>
        <Select.Root value={tier} onValueChange={setTier}>
          <Select.Trigger id="radix-tier" name="tier" aria-labelledby="radix-tier-label">
            <Select.Value placeholder="Select a tier" />
          </Select.Trigger>
          <Select.Portal>
            <Select.Content>
              <Select.Viewport>
                {TIERS.map((option) => (
                  <Select.Item key={option.value} value={option.value}>
                    <Select.ItemText>{option.label}</Select.ItemText>
                  </Select.Item>
                ))}
              </Select.Viewport>
            </Select.Content>
          </Select.Portal>
        </Select.Root>

        <span className="field-label" id="radix-backups-label">
          Nightly backups
        </span>
        <Switch.Root
          id="radix-backups"
          checked={backups}
          onCheckedChange={setBackups}
          aria-labelledby="radix-backups-label"
        >
          <Switch.Thumb />
        </Switch.Root>
      </div>

      <pre id="radix-state">{JSON.stringify({ region, tier, backups })}</pre>

      <field-fox
        target="#radix-form"
        endpoint="http://localhost:8787/api/fill"
        site-key="ffx_pk_dev0000000000000000000000000000"
      ></field-fox>
    </main>
  );
}
