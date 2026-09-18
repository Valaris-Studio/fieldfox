import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { EnquiryDialog } from "./enquiry/EnquiryDialog";
const FieldLab = lazy(() => import("./FieldLab"));
const repo = "https://github.com/Valaris-Studio/fieldfox";
const stages = [
  {
    title: "Bring what you have.",
    text: "An email. A photo. A product sheet. The useful details are already there. Let’s give them somewhere to go.",
    detail: "Text & images · optional PDF and text attachments",
    tag: "01 / THE SOURCE",
  },
  {
    title: "Give it a little direction.",
    text: "FieldFox reads your supported form and asks your configured model to propose values that fit. Less moving between windows. Less starting from scratch.",
    detail: "Source + form → server & model → validated plan",
    tag: "02 / THE LITTLE HELPER",
  },
  {
    title: "You have the final say.",
    text: "Proposed values land in your form, ready to check and edit. Missing information should stay missing. You decide what happens next.",
    detail: "Supported writes → readback → your review",
    tag: "03 / YOUR FORM, YOUR CALL",
  },
];
function FoxMark() {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <path fill="currentColor" d="M8 8 26 20h12L56 8l-2 35-22 15L10 43Z" />
      <path fill="var(--paper)" d="m12 30 20 12 20-12-8 16-12 9-12-9Z" />
      <path fill="var(--ink)" d="m27 41 5 6 5-6Z" />
    </svg>
  );
}
function Arrow() {
  return <span aria-hidden="true">↗</span>;
}
function useReducedMotion() {
  const [reduced, setReduced] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const q = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(q.matches);
    q.addEventListener("change", update);
    return () => q.removeEventListener("change", update);
  }, []);
  return reduced;
}
function Example() {
  const [filled, setFilled] = useState(false);
  const [name, setName] = useState(""),
    [sku, setSku] = useState(""),
    [material, setMaterial] = useState(""),
    [weight, setWeight] = useState("");
  function fill() {
    setName("Arc desk lamp");
    setSku("ARC-204");
    setMaterial("Aluminium");
    setFilled(true);
  }
  function reset() {
    setName("");
    setSku("");
    setMaterial("");
    setWeight("");
    setFilled(false);
  }
  return (
    <section
      className="example section-wrap"
      id="in-practice"
      aria-labelledby="example-title"
    >
      <div className="section-heading">
        <p className="eyebrow">A SMALL EXAMPLE. A FAMILIAR FEELING.</p>
        <h2 id="example-title">
          From “it’s in the email”
          <br />
          to <em>right here.</em>
        </h2>
        <p>
          See the idea with a made-up product. Then edit the result yourself.
        </p>
      </div>
      <div className="example-workbench">
        <article className="source-note">
          <div className="note-top">
            <span className="dot" /> SOURCE / 001 <span>↙</span>
          </div>
          <p className="note-subject">A note from your supplier</p>
          <p>
            Here are the details for the
            <br />
            <mark>Arc desk lamp.</mark>
          </p>
          <p>
            Reference: <mark>ARC-204</mark>
            <br />
            Made from <mark>aluminium.</mark>
            <br />
            We’ll confirm the weight later.
          </p>
          <span className="note-stamp">SAMPLE MATERIAL</span>
        </article>
        <div className="example-connector" aria-hidden="true">
          <FoxMark />
          <span>→</span>
        </div>
        <div className="sample-form">
          <div className="form-top">
            <span>YOUR EXISTING FORM</span>
            <span className="tiny-badge">Product</span>
          </div>
          <div className="form-fields">
            <label>
              Product name
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Waiting for a little help"
              />
            </label>
            <div className="field-row">
              <label>
                Reference
                <input
                  value={sku}
                  onChange={(e) => setSku(e.target.value)}
                  placeholder="—"
                />
              </label>
              <label>
                Material
                <input
                  value={material}
                  onChange={(e) => setMaterial(e.target.value)}
                  placeholder="—"
                />
              </label>
            </div>
            <label>
              Weight <span className="label-note">not in the source</span>
              <input
                value={weight}
                onChange={(e) => setWeight(e.target.value)}
                placeholder="Leave unknown, or add it yourself"
              />
            </label>
          </div>
          <p className="example-feedback" aria-live="polite">
            {filled
              ? "Three proposed values. Check them against the note."
              : "Your form stays yours. Including the finishing touches."}
          </p>
          <button
            className="button button-dark"
            onClick={filled ? reset : fill}
          >
            {filled ? "Reset the example" : "Place the sample values"}
            <span aria-hidden="true">{filled ? "↺" : "→"}</span>
          </button>
          <p className="sample-disclosure">
            Illustrative interaction with fixed values. No model call or data
            upload.
          </p>
        </div>
      </div>
      <div className="principles">
        <div>
          <span>01</span>
          <h3>Your form stays.</h3>
          <p>Add a helper to the interface people already know.</p>
        </div>
        <div>
          <span>02</span>
          <h3>Leave room for unknowns.</h3>
          <p>A missing fact is a reason to pause, not invent.</p>
        </div>
        <div>
          <span>03</span>
          <h3>Nothing auto-submits.</h3>
          <p>Check, correct, and continue in your own app.</p>
        </div>
      </div>
    </section>
  );
}
export default function App() {
  const reducedMotion = useReducedMotion();
  const [still, setStill] = useState(false);
  const [stage, setStage] = useState(0);
  const [intent, setIntent] = useState<"project" | "start">("project");
  const [enquiryOpen, setEnquiryOpen] = useState(false);
  const story = useRef<HTMLElement>(null);
  const openEnquiry = (value: "project" | "start") => {
    setIntent(value);
    setEnquiryOpen(true);
  };
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (window.matchMedia("(max-width: 760px)").matches) return;
        for (const entry of entries)
          if (entry.isIntersecting)
            setStage(Number((entry.target as HTMLElement).dataset.storyStage));
      },
      { rootMargin: "-30% 0px -40% 0px", threshold: 0 },
    );
    story.current
      ?.querySelectorAll("[data-story-stage]")
      .forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, []);
  function chooseStage(index: number) {
    setStage(index);
    if (window.matchMedia("(max-width: 760px)").matches) return;
    document.getElementById(`chapter-${index}`)?.scrollIntoView({
      behavior: reducedMotion ? "instant" : "smooth",
      block: "center",
    });
  }
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="site-header">
        <a href="#" className="wordmark" aria-label="FieldFox home">
          <FoxMark />
          FieldFox
        </a>
        <nav aria-label="Main navigation">
          <a href="#how-it-works">How it works</a>
          <a href="#for-builders">For builders</a>
          <a className="nav-source" href={repo}>
            Open source <Arrow />
          </a>
        </nav>
        <button className="header-cta" onClick={() => openEnquiry("start")}>
          Let’s talk <Arrow />
        </button>
      </header>
      <main id="main">
        <section
          className="lab-story"
          ref={story}
          id="how-it-works"
          aria-label="How FieldFox works"
        >
          <div className="story-copy">
            <div className="hero-copy" data-story-stage="0">
              <p className="eyebrow">
                <span className="live-dot" /> A LITTLE HELP FOR YOUR FORMS
              </p>
              <h1>
                Less typing.
                <br />
                <em>More doing.</em>
              </h1>
              <p className="hero-description">
                The information is already there.
                <br />
                FieldFox helps put it in the right place.
              </p>
              <p className="hero-secondary">
                Turn messages, images and documents into proposed values for the
                forms you already built.
              </p>
              <button
                className="button button-orange"
                onClick={() => openEnquiry("project")}
              >
                I want to add it to my projects <Arrow />
              </button>
              <p className="hero-footnote">
                Open source. Self-hostable. Always your final say.
              </p>
              <a href="#chapter-0" className="scroll-cue">
                <span>↓</span> Follow the little fox
              </a>
            </div>
            {stages.map((item, index) => (
              <article
                className="story-chapter"
                id={`chapter-${index}`}
                data-story-stage={index}
                key={item.tag}
              >
                <p className="eyebrow">{item.tag}</p>
                <h2>{item.title}</h2>
                <p>{item.text}</p>
                <div className="technical-caption">
                  <span aria-hidden="true">⌁</span>
                  {item.detail}
                </div>
                {index === 0 && (
                  <p className="chapter-note">
                    Image and PDF understanding depends on your chosen model.
                  </p>
                )}
                {index === 2 && (
                  <p className="chapter-note">
                    Readback checks that a write took effect. It doesn’t prove
                    that the model got the facts right.
                  </p>
                )}
              </article>
            ))}
          </div>
          <div className="lab-column">
            <div className="lab-sticky">
              <div className="lab-topline">
                <span>THE FIELDFOX LAB</span>
                <button onClick={() => setStill(!still)} aria-pressed={still}>
                  {still ? "Motion off" : "Still mode"}
                  <span aria-hidden="true">{still ? "◉" : "◎"}</span>
                </button>
              </div>
              <div className="scene-frame">
                <Suspense
                  fallback={
                    <img
                      className="scene-loading"
                      src="/assets/sorting-machine.webp"
                      alt="An orange fox-shaped sorter connects source cards to a form tray."
                    />
                  }
                >
                  <FieldLab
                    stage={stage}
                    reducedMotion={reducedMotion || still}
                  />
                </Suspense>
              </div>
              <div className="scene-bottom">
                <p>
                  <span className="live-dot" />{" "}
                  {
                    [
                      "A place for every little detail.",
                      "A little structure goes a long way.",
                      "The last step belongs to you.",
                    ][stage]
                  }
                </p>
                <span className="scene-counter">0{stage + 1} / 03</span>
              </div>
              <div
                className="stage-selector"
                aria-label="Explore the three stages"
              >
                {["Bring it", "Shape it", "Review it"].map((label, index) => (
                  <button
                    key={label}
                    aria-pressed={stage === index}
                    onClick={() => chooseStage(index)}
                  >
                    <span>0{index + 1}</span>
                    {label}
                  </button>
                ))}
              </div>
              <p className="scene-caption">
                A playful model of a real workflow. Scroll to explore.
              </p>
            </div>
          </div>
        </section>
        <Example />
        <section
          className="builders"
          id="for-builders"
          aria-labelledby="builder-title"
        >
          <div className="section-wrap builder-inner">
            <div className="builder-intro">
              <p className="eyebrow">
                SMALL ON THE SURFACE. THOUGHTFUL UNDERNEATH.
              </p>
              <h2 id="builder-title">
                Your interface.
                <br />A new <em>superpower.</em>
              </h2>
              <p>
                A framework-agnostic web component, a server, and your
                compatible model provider. Add FieldFox beside a supported form.
                Keep your application in charge.
              </p>
              <a
                className="text-link"
                href={`${repo}/blob/main/docs/SELF-HOSTING.md`}
              >
                Explore the self-hosting guide <Arrow />
              </a>
              <div className="builder-tags">
                <span>MIT LICENSED</span>
                <span>WEB COMPONENT</span>
                <span>OWN PROVIDER</span>
              </div>
            </div>
            <div className="code-window">
              <div className="code-window-top">
                <span>your-app.html</span>
                <span>↗</span>
              </div>
              <pre>
                <code>
                  <span className="code-muted">
                    {"<!-- Load your built widget first. -->"}
                  </span>
                  {"\n"}
                  <span className="code-orange">{"<field-fox"}</span>
                  {"\n  target="}
                  <span className="code-lime">{'"#product-form"'}</span>
                  {"\n  endpoint="}
                  <span className="code-lime">{'"/api/fill"'}</span>
                  {"\n  site-key="}
                  <span className="code-lime">{'"ffx_pk_YOUR_SITE_KEY"'}</span>
                  {"\n  accept-documents\n"}
                  <span className="code-orange">{"></field-fox>"}</span>
                </code>
              </pre>
              <div className="code-note">
                <span>↳</span>
                <p>
                  Connect the endpoint to your configured FieldFox server.
                  Provider credentials stay on the server.
                </p>
              </div>
              <a href={`${repo}/blob/main/docs/EMBEDDING.md`}>
                Read the complete integration guide <Arrow />
              </a>
            </div>
            <div className="technical-details">
              <details>
                <summary>
                  <span>01</span> What forms does it understand?
                  <span className="detail-plus">+</span>
                </summary>
                <p>
                  Supported native inputs, selects, checkboxes and radios; React
                  controlled inputs; supported ARIA widgets; and
                  ProseMirror-based rich-text editors, including tiptap. Custom
                  component behavior still matters. Unsupported controls are
                  left unwritten.{" "}
                  <a href={`${repo}/blob/main/docs/COVERAGE.md`}>
                    Inspect the coverage guide ↗
                  </a>
                </p>
              </details>
              <details>
                <summary>
                  <span>02</span> Where does the information go?
                  <span className="detail-plus">+</span>
                </summary>
                <p>
                  The supplied source, form schema and included field context go
                  to your configured server and model provider. Self-hosting
                  does not make a remote provider local. Choose a provider
                  appropriate for your data and review the outgoing schema.
                </p>
              </details>
              <details>
                <summary>
                  <span>03</span> What does “validated” actually mean?
                  <span className="detail-plus">+</span>
                </summary>
                <p>
                  The server validates the proposed plan. The widget applies
                  supported writes and reads the fields back to check the
                  result. These are structural and write checks, not proof of
                  factual accuracy. Compare the values with the original source.
                  FieldFox never submits the form.
                </p>
              </details>
              <details>
                <summary>
                  <span>04</span> How can I start using it?
                  <span className="detail-plus">+</span>
                </summary>
                <p>
                  Evaluate the MIT-licensed source and local examples, or talk
                  with us about your project. Self-hosting requires your own
                  server and compatible provider configuration; your
                  infrastructure and provider costs apply. There is no available
                  FieldFox Cloud service.
                </p>
              </details>
            </div>
          </div>
        </section>
        <section className="closing section-wrap">
          <div className="closing-image">
            <img
              src="/assets/review-detail.webp"
              onError={(e) => {
                e.currentTarget.onerror = null;
                e.currentTarget.src = "/assets/review-station.webp";
              }}
              alt="A pencil rests beside an unfinished form tray and a little orange fox sorter."
              loading="lazy"
              width="1536"
              height="1024"
            />
            <span className="image-label">THE HUMAN PART IS STILL YOURS.</span>
          </div>
          <div className="closing-copy">
            <p className="eyebrow">GOT A FORM IN MIND?</p>
            <h2>
              Let’s make
              <br />
              room for the
              <br />
              <em>good stuff.</em>
            </h2>
            <p>
              Tell us a little about what you’re building. We can start with a
              conversation.
            </p>
            <button
              className="button button-dark"
              onClick={() => openEnquiry("start")}
            >
              I want to start using it <Arrow />
            </button>
            <a className="quiet-link" href={repo}>
              Or take a look around the source ↗
            </a>
          </div>
        </section>
      </main>
      <footer className="site-footer section-wrap">
        <div className="footer-top">
          <a href="#" className="wordmark">
            <FoxMark />
            FieldFox
          </a>
          <span>
            A little less busywork.
            <br />A little more possibility.
          </span>
          <div>
            <a href="https://valaris.studio">Made by Valaris Studio ↗</a>
            <a href={`${repo}/blob/main/LICENSE`}>Open source · MIT ↗</a>
          </div>
        </div>
        <div className="footer-bottom">
          <span>INFORMATION IN. HUMAN JUDGMENT OUT.</span>
          <a
            href="#privacy"
            onClick={() => {
              const privacy = document.getElementById(
                "privacy",
              ) as HTMLDetailsElement;
              privacy.open = true;
            }}
          >
            Data & privacy
          </a>
          <button onClick={() => openEnquiry("start")}>Contact ↗</button>
        </div>
        <details id="privacy" className="privacy-note">
          <summary>About this website & your information</summary>
          <p>
            The interactive example uses fixed sample values and sends no source
            material to a model. This website includes no analytics or
            advertising scripts. The contact form sends only the details you
            review on its final step, when delivery is configured; an
            unavailable destination is reported as a failure. Do not include
            passwords, sensitive documents or confidential project data in an
            enquiry. Contact details are used to respond to your enquiry.
          </p>
        </details>
      </footer>
      <EnquiryDialog
        open={enquiryOpen}
        onClose={() => setEnquiryOpen(false)}
        intent={intent}
      />
    </>
  );
}
