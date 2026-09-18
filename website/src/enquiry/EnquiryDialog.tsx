import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import "./enquiry.css";

type Intent = "project" | "start";
type Receipt = { id: string; status: "accepted"; testMode?: boolean };
type Props = { open: boolean; onClose: () => void; intent: Intent };
const steps = ["Your project", "Say hello", "One last look"];

function meetingUrl() {
  const configured = import.meta.env.VITE_FIELDFOX_MEETING_URL;
  if (!configured) return null;
  try {
    const url = new URL(configured);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

export function EnquiryDialog({ open, onClose, intent }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const sending = useRef(false);
  const attempt = useRef<{ fingerprint: string; key: string } | null>(null);
  const [step, setStep] = useState(0);
  const [useCase, setUseCase] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<
    "idle" | "sending" | "failed" | "accepted"
  >("idle");
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  const booking = meetingUrl();

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (!open) {
      if (element.open) element.close();
      return;
    }
    const trigger =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    if (!element.open) element.showModal();
    heading.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      if (element.open) element.close();
      trigger?.focus();
    };
  }, [open]);

  useEffect(() => {
    if (open) heading.current?.focus();
  }, [step, status === "accepted"]);

  function containFocus(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key !== "Tab") return;
    const controls = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), a[href], [tabindex="0"]',
      ),
    ).filter((element) => element.getClientRects().length > 0);
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (
      event.shiftKey &&
      (document.activeElement === first ||
        document.activeElement === heading.current)
    ) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }

  function edit(next: number) {
    if (sending.current) return;
    setStep(next);
    setError("");
    setStatus("idle");
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (sending.current || receipt) return;
    const projectField = form.current?.elements.namedItem(
      "project",
    ) as HTMLTextAreaElement | null;
    const nameField = form.current?.elements.namedItem(
      "name",
    ) as HTMLInputElement | null;
    projectField?.setCustomValidity(
      useCase.trim().length < 3
        ? "Please add a few words about your project."
        : "",
    );
    nameField?.setCustomValidity(name.trim() ? "" : "Please enter your name.");
    if (!form.current?.reportValidity()) return;
    if (step < 2) {
      setStep(step + 1);
      return;
    }
    const details = {
      intent,
      useCase: useCase.trim(),
      name: name.trim(),
      email: email.trim(),
    };
    const fingerprint = JSON.stringify(details);
    if (attempt.current?.fingerprint !== fingerprint)
      attempt.current = { fingerprint, key: crypto.randomUUID() };
    sending.current = true;
    setStatus("sending");
    setError("");
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch("/api/enquiries", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": attempt.current.key,
        },
        body: fingerprint,
        signal: controller.signal,
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) {
        if (result?.error === "not_configured")
          throw new Error(
            "Enquiry delivery is not connected yet. Your details have not been sent. You can keep exploring the open-source project below.",
          );
        if (response.status === 400)
          throw new Error(
            "Please go back and check your name, email and project description.",
          );
        throw new Error(
          "We could not confirm delivery. Your details are still here. Retry to check or send this same enquiry.",
        );
      }
      if (
        result?.status !== "accepted" ||
        typeof result.id !== "string" ||
        !result.id.trim()
      )
        throw new Error(
          "We could not confirm delivery. Please retry this same enquiry.",
        );
      setReceipt(result);
      setStatus("accepted");
    } catch (failure) {
      setError(
        failure instanceof Error &&
          failure.name !== "AbortError" &&
          failure.name !== "TypeError"
          ? failure.message
          : "The connection was interrupted. Delivery is unconfirmed. Retry to check or send this same enquiry.",
      );
      setStatus("failed");
    } finally {
      window.clearTimeout(timeout);
      sending.current = false;
    }
  }

  return (
    <dialog
      ref={dialog}
      className="enquiry-dialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onKeyDown={containFocus}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="enquiry-shell">
        <aside className="enquiry-aside" aria-hidden="true">
          <span className="enquiry-wordmark">
            fieldfox<span>↗</span>
          </span>
          <div className="enquiry-paper-stack">
            <div />
            <div />
            <div>
              <span>LESS COPYING.</span>
              <strong>
                More
                <br />
                possibility.
              </strong>
              <i>↗</i>
            </div>
          </div>
          <p>
            A little context.
            <br />A useful conversation.
          </p>
        </aside>
        <div className="enquiry-main">
          <button
            type="button"
            className="enquiry-close"
            onClick={onClose}
            aria-label="Close enquiry"
          >
            ×
          </button>
          {status === "accepted" && receipt ? (
            <div className="enquiry-success">
              <span className="enquiry-eyebrow">
                {receipt.testMode ? "LOCAL TEST RECEIPT" : "ENQUIRY RECEIVED"}
              </span>
              <div className="enquiry-check" aria-hidden="true">
                ✓
              </div>
              <h2 id={titleId} ref={heading} tabIndex={-1}>
                {receipt.testMode ? "A good test run." : "Hello, possibility."}
              </h2>
              <p id={descriptionId}>
                {receipt.testMode
                  ? "Your test enquiry was saved locally. No message was sent to a person."
                  : "Your enquiry has been accepted. Thank you for sharing what you have in mind."}
              </p>
              <p className="enquiry-receipt">
                Receipt <code>{receipt.id}</code>
              </p>
              {booking && !receipt.testMode && (
                <a
                  className="enquiry-primary"
                  href={booking}
                  target="_blank"
                  rel="noreferrer"
                >
                  Find a time to talk <span aria-hidden="true">↗</span>
                </a>
              )}
              <button
                className={
                  booking && !receipt.testMode
                    ? "enquiry-text-button"
                    : "enquiry-primary"
                }
                type="button"
                onClick={onClose}
              >
                Back to FieldFox <span aria-hidden="true">↗</span>
              </button>
            </div>
          ) : (
            <>
              <ol className="enquiry-progress" aria-label="Enquiry progress">
                {steps.map((label, index) => (
                  <li
                    key={label}
                    aria-current={step === index ? "step" : undefined}
                    className={index <= step ? "is-reached" : ""}
                  >
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <span>{label}</span>
                  </li>
                ))}
              </ol>
              <h2 id={titleId} ref={heading} tabIndex={-1}>
                {step === 0
                  ? "What could we make easier?"
                  : step === 1
                    ? "Who shall we talk to?"
                    : "Looks like a good start."}
              </h2>
              <p id={descriptionId} className="enquiry-description">
                {step === 0
                  ? "Tell us a little about the forms in your world."
                  : step === 1
                    ? "Just enough to continue the conversation."
                    : "A quick check, then let’s talk about your project."}
              </p>
              <form ref={form} onSubmit={submit}>
                {step === 0 && (
                  <div className="enquiry-fields">
                    <label htmlFor="enquiry-project">
                      What would you like to use FieldFox for?
                    </label>
                    <textarea
                      id="enquiry-project"
                      name="project"
                      required
                      minLength={3}
                      maxLength={2000}
                      rows={4}
                      placeholder="For example, turning customer emails into an enquiry form…"
                      value={useCase}
                      onChange={(event) => {
                        event.target.setCustomValidity("");
                        setUseCase(event.target.value);
                      }}
                      aria-describedby="enquiry-project-hint"
                    />
                    <p id="enquiry-project-hint" className="enquiry-hint">
                      A sentence is plenty. Please leave out sensitive
                      information.
                    </p>
                  </div>
                )}
                {step === 1 && (
                  <div className="enquiry-fields">
                    <label htmlFor="enquiry-name">Your name</label>
                    <input
                      id="enquiry-name"
                      name="name"
                      autoComplete="name"
                      required
                      maxLength={120}
                      value={name}
                      onChange={(event) => {
                        event.target.setCustomValidity("");
                        setName(event.target.value);
                      }}
                      placeholder="Alex"
                    />
                    <label htmlFor="enquiry-email">Email address</label>
                    <input
                      id="enquiry-email"
                      name="email"
                      type="email"
                      autoComplete="email"
                      inputMode="email"
                      required
                      maxLength={254}
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      placeholder="you@example.com"
                    />
                    <p className="enquiry-hint">
                      We ask for your email so a person can reply about this
                      enquiry.
                    </p>
                  </div>
                )}
                {step === 2 && (
                  <div className="enquiry-review">
                    <div>
                      <div>
                        <span>Your project</span>
                        <button
                          type="button"
                          disabled={status === "sending"}
                          onClick={() => edit(0)}
                        >
                          Edit project
                        </button>
                      </div>
                      <p>{useCase}</p>
                    </div>
                    <div>
                      <div>
                        <span>Your contact</span>
                        <button
                          type="button"
                          disabled={status === "sending"}
                          onClick={() => edit(1)}
                        >
                          Edit contact
                        </button>
                      </div>
                      <p>
                        {name}
                        <br />
                        {email}
                      </p>
                    </div>
                    <p className="enquiry-hint">
                      Sending shares these details with the website’s configured
                      enquiry service. Please include only information you are
                      comfortable sharing.
                    </p>
                  </div>
                )}
                {error && (
                  <div className="enquiry-error" role="alert">
                    <strong>Not confirmed yet.</strong>
                    <p>{error}</p>
                    <a
                      href="https://github.com/Valaris-Studio/fieldfox"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Explore the source and self-hosting guide ↗
                    </a>
                  </div>
                )}
                <div className="enquiry-actions">
                  {step > 0 && (
                    <button
                      className="enquiry-back"
                      type="button"
                      disabled={status === "sending"}
                      onClick={() => edit(step - 1)}
                    >
                      ← Back
                    </button>
                  )}
                  <button
                    className="enquiry-primary"
                    type="submit"
                    disabled={status === "sending"}
                  >
                    {status === "sending"
                      ? "Sending your enquiry…"
                      : step < 2
                        ? "Continue"
                        : status === "failed"
                          ? "Retry enquiry"
                          : "Send my enquiry"}
                    <span aria-hidden="true">
                      {status === "sending" ? "· · ·" : "↗"}
                    </span>
                  </button>
                </div>
                <p className="enquiry-footnote" role="status">
                  {status === "sending"
                    ? "Waiting for a confirmed receipt."
                    : step < 2
                      ? "Nothing is sent until you review and confirm."
                      : "An enquiry starts a conversation. No account or purchase."}
                </p>
              </form>
            </>
          )}
        </div>
      </div>
    </dialog>
  );
}
