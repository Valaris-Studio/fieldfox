import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { RadixForm } from './RadixForm';
import './styles.css';

// The Radix driver fixture lives on its OWN route, not alongside the profile
// form. Two <field-fox> elements on one page would make the e2e suite's bare
// `field-fox [part="…"]` locators ambiguous, and those selectors are the
// framework-matrix test's contract.
const Page = window.location.pathname.startsWith('/radix') ? RadixForm : App;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Page />
  </StrictMode>,
);
