import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import * as Select from '@radix-ui/react-select';
import * as Switch from '@radix-ui/react-switch';
// Side effect only: registers the field-fox custom element (this route mounts
// without App.tsx, so it cannot rely on that module's import).
import '@fieldfox/widget';

// The COVERAGE fixture (card b260cfd6): one realistic business-app form that
// combines every pattern the drivers must survive at once, so the coverage table
// in docs/COVERAGE.md is measured against a single hard form rather than a set of
// easy ones.
//
// What makes this different from the App/Radix fixtures, which each isolate one
// pattern: here react-hook-form OWNS the state of the design-system widgets via
// Controller. That is the acid test — the driver mutates the DOM, and RHF only
// learns about it if the driver dispatches events the Controller's onChange is
// actually listening for. A naive `.value =` assignment updates the pixels and
// silently loses the value on submit.
//
// `submitted` renders the RHF state after submit, so an e2e can assert what the
// FORM MODEL holds, not merely what the DOM shows. A field that looks filled but
// is missing from this JSON is exactly the silent failure this fixture exists to
// catch.

interface Ticket {
  requesterName: string;
  workEmail: string;
  seatCount: string;
  startDate: string;
  environment: string;
  supportTier: string;
  pagerDuty: boolean;
  description: string;
}

// Regions, not environments: the e2e mock plans a canned combobox value for
// name="region", which is what makes this control the POSITIVE fill case that
// balances the unmatchable leave-probe below.
const REGIONS = [
  { value: 'sa-east-1', label: 'Sao Paulo' },
  { value: 'us-west-2', label: 'Oregon' },
  { value: 'eu-central-1', label: 'Frankfurt' },
];

const TIERS = [
  { value: 'bronze', label: 'Bronze' },
  { value: 'silver', label: 'Silver' },
  { value: 'gold', label: 'Gold' },
];

export function CoverageForm() {
  const { register, control, handleSubmit } = useForm<Ticket>({
    defaultValues: {
      requesterName: '',
      workEmail: '',
      seatCount: '',
      startDate: '',
      environment: '',
      supportTier: '',
      pagerDuty: false,
      description: '',
    },
  });
  const [submitted, setSubmitted] = useState<Ticket | null>(null);
  // The deliberately UNSUPPORTED widget (see below): a custom control with no
  // ARIA role any driver claims. Its state lives outside RHF entirely.
  const [priority, setPriority] = useState('unset');

  return (
    <main id="coverage-section">
      <h1>Capacity request (coverage harness)</h1>
      <p className="muted">
        react-hook-form + Radix via Controller — RHF owns the design-system widgets&apos; state.
      </p>

      <form id="coverage-form" onSubmit={handleSubmit((data) => setSubmitted(data))} noValidate>
        {/* Plain register()'d inputs: the baseline every driver-free fill uses. */}
        <label htmlFor="cov-name">Requester name</label>
        <input id="cov-name" type="text" autoComplete="name" {...register('requesterName')} />

        <label htmlFor="cov-email">Work email</label>
        <input id="cov-email" type="email" autoComplete="email" {...register('workEmail')} />

        <label htmlFor="cov-seats">Seat count</label>
        <input id="cov-seats" type="number" {...register('seatCount')} />

        <label htmlFor="cov-start">Requested start date</label>
        <input id="cov-start" type="date" {...register('startDate')} />

        {/* Controller-wrapped Radix Select. The driver picks through the ARIA
            contract; RHF only records it if onValueChange fires. */}
        <span className="field-label" id="cov-environment-label">
          Region
        </span>
        <Controller
          name="environment"
          control={control}
          render={({ field }) => (
            <Select.Root value={field.value} onValueChange={field.onChange}>
              <Select.Trigger
                id="cov-environment"
                name="region"
                aria-labelledby="cov-environment-label"
              >
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
          )}
        />

        <span className="field-label" id="cov-tier-label">
          Support tier
        </span>
        <Controller
          name="supportTier"
          control={control}
          render={({ field }) => (
            <Select.Root value={field.value} onValueChange={field.onChange}>
              {/* name="plan", NOT "tier": the e2e mock plans combobox values by
                  field name, and an unmapped name falls through to its
                  deliberately-unmatchable value. That makes this control the
                  leave-semantics probe on THIS form — the safety invariant
                  measured where react-hook-form owns the state. */}
              <Select.Trigger id="cov-tier" name="plan" aria-labelledby="cov-tier-label">
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
          )}
        />

        {/* Controller-wrapped Radix Switch — same test, boolean flavour. */}
        <span className="field-label" id="cov-pager-label">
          Nightly backups pager
        </span>
        <Controller
          name="pagerDuty"
          control={control}
          render={({ field }) => (
            <Switch.Root
              id="cov-pager"
              checked={field.value}
              onCheckedChange={field.onChange}
              aria-labelledby="cov-pager-label"
            >
              <Switch.Thumb />
            </Switch.Root>
          )}
        />

        <label htmlFor="cov-description">Description</label>
        <textarea id="cov-description" rows={4} {...register('description')} />

        {/* THE NEGATIVE CASE — deliberately unsupported.
            A div-based custom control with no role any driver claims: not a
            combobox, not a switch, not contenteditable. The widget must
            introspect it as fillable:false and LEAVE it at "unset". If a future
            change ever makes this fill, that is a regression toward guessing,
            not a coverage win. */}
        <span className="field-label" id="cov-priority-label">
          Priority (custom control)
        </span>
        <div
          id="cov-priority"
          data-testid="cov-priority"
          aria-labelledby="cov-priority-label"
          className="pill-group"
        >
          {['low', 'high'].map((level) => (
            <span
              key={level}
              className={priority === level ? 'pill pill-on' : 'pill'}
              onClick={() => setPriority(level)}
            >
              {level}
            </span>
          ))}
        </div>

        <button type="submit">Submit request</button>
      </form>

      {/* The live custom-control state, so a spec can assert it was left alone. */}
      <pre id="coverage-custom-state">{JSON.stringify({ priority })}</pre>

      {/* RHF's model after submit — proves values reached the FORM, not just the DOM. */}
      {submitted && <pre id="coverage-submitted">{JSON.stringify(submitted, null, 2)}</pre>}

      <field-fox
        target="#coverage-form"
        endpoint="http://localhost:8787/api/fill"
        site-key="ffx_pk_dev0000000000000000000000000000"
      ></field-fox>
    </main>
  );
}
