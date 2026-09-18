import { createEnquiryServer } from "./enquiries.mjs";

const mode = process.env.FIELDFOX_ENQUIRY_MODE || "unconfigured";
if (mode === "local-test" && process.env.NODE_ENV === "production")
  throw new Error("Local test delivery must not run in production.");
if (mode === "webhook" && !process.env.FIELDFOX_PUBLIC_ORIGIN)
  throw new Error(
    "Set FIELDFOX_PUBLIC_ORIGIN before enabling webhook delivery.",
  );
const server = createEnquiryServer({
  mode,
  directory: process.env.FIELDFOX_ENQUIRY_TEST_DIR,
  webhookUrl: process.env.FIELDFOX_ENQUIRY_WEBHOOK_URL,
  webhookToken: process.env.FIELDFOX_ENQUIRY_WEBHOOK_TOKEN,
  publicOrigin: process.env.FIELDFOX_PUBLIC_ORIGIN || "http://127.0.0.1:4188",
});
const port = Number(process.env.FIELDFOX_ENQUIRY_PORT || 4189);
server.listen(port, "127.0.0.1", () =>
  console.log(`FieldFox enquiry service: http://127.0.0.1:${port} (${mode})`),
);
