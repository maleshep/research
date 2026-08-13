import { readFileSync } from "node:fs";

const PORT = 5192;
const RESUME_PATH = "C:/Users/M316235/repo/testgrounds/output/pdf/simon_kucher_director_data_science_gen_ai_healthcare_and_life_sciences_m_f_d/simon_kucher_director_data_science_gen_ai_healthcare_and_life_sciences_m_f_d_resume.pdf";
const COVER_LETTER_PATH = "C:/Users/M316235/repo/testgrounds/output/pdf/simon_kucher_director_data_science_gen_ai_healthcare_and_life_sciences_m_f_d/simon_kucher_director_data_science_gen_ai_healthcare_and_life_sciences_m_f_d_cover_letter.pdf";

async function cdp(sessionId, method, params = {}) {
  // Connect to the browser-level websocket
  const version = await fetch(`http://127.0.0.1:${PORT}/json/version`);
  const { webSocketDebuggerUrl } = await version.json();
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("ws failed")), { once: true });
  });

  let id = 1;
  function send(method, params, sid) {
    return new Promise((resolve, reject) => {
      const msgId = id++;
      const payload = JSON.stringify({ id: msgId, method, params, ...(sid ? { sessionId: sid } : {}) });
      const timer = setTimeout(() => { ws.close(); reject(new Error(`timeout: ${method}`)); }, 10000);
      ws.addEventListener("message", function handler(event) {
        try {
          const data = JSON.parse(String(event.data));
          if (data.id === msgId) {
            ws.removeEventListener("message", handler);
            clearTimeout(timer);
            if (data.error) reject(new Error(JSON.stringify(data.error)));
            else resolve(data.result);
          }
        } catch {}
      });
      ws.send(payload);
    });
  }

  // Find the page target
  const targets = await send("Target.getTargets", {});
  const page = targets.targetInfos.find(t => t.type === "page" && t.url.includes("csod.com"));
  if (!page) throw new Error("CSOD page not found");
  console.log("Found page:", page.title);

  // Attach to the target
  const attached = await send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
  const sid = attached.sessionId;
  console.log("Attached, sessionId:", sid);

  // Enable DOM domain
  await send("DOM.enable", {}, sid);

  // Find the file input element
  const doc = await send("DOM.getDocument", { depth: -1, pierce: true }, sid);

  // Search for the file input by selector
  const resumeInput = await send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "#resumeFileUpload" }, sid);
  console.log("Resume input nodeId:", resumeInput.nodeId);

  // Set the file
  const resumeData = readFileSync(RESUME_PATH);
  await send("DOM.setFileInputFiles", {
    nodeId: resumeInput.nodeId,
    files: [RESUME_PATH],
  }, sid);
  console.log("Resume uploaded!");

  // Wait for upload to process
  await new Promise(r => setTimeout(r, 3000));

  // Try to upload cover letter too
  const clInput = await send("DOM.querySelector", { nodeId: doc.root.nodeId, selector: "#attachment_upload_0_1986_0" }, sid);
  if (clInput.nodeId) {
    console.log("Cover letter input nodeId:", clInput.nodeId);
    await send("DOM.setFileInputFiles", {
      nodeId: clInput.nodeId,
      files: [COVER_LETTER_PATH],
    }, sid);
    console.log("Cover letter uploaded!");
  } else {
    console.log("Cover letter input not found");
  }

  await new Promise(r => setTimeout(r, 2000));
  ws.close();
  console.log("Done!");
}

cdp().catch(e => { console.error("Error:", e.message); process.exit(1); });
