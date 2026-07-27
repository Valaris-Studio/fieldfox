import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { RadixForm } from './RadixForm';
import { EditorForm } from './EditorForm';
import { CoverageForm } from './CoverageForm';
import './styles.css';

// Each driver fixture gets its OWN route. Two <field-fox> elements on one page
// would make the e2e suite's bare `field-fox [part="…"]` locators ambiguous, and
// those selectors are the framework-matrix test's contract.
const ROUTES: Record<string, () => React.JSX.Element> = {
  '/radix': RadixForm,
  '/editor': EditorForm,
  '/coverage': CoverageForm,
};

const Page = ROUTES[window.location.pathname] ?? App;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Page />
  </StrictMode>,
);
