import type { IngestionResult, ResolvedRecord, VerificationVerdict, ResolvedPaper } from './types';

export class LoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoadError';
  }
}

/** Read a File as an ArrayBuffer. */
export function readAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(new LoadError(`Could not read file: ${file.name}`));
    reader.readAsArrayBuffer(file);
  });
}

/** Read a File as UTF-8 text. */
export function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new LoadError(`Could not read file: ${file.name}`));
    reader.readAsText(file, 'utf-8');
  });
}

/** Parse and validate an IngestionResult JSON file (Phase 1). */
export async function loadIngestionResult(file: File): Promise<IngestionResult> {
  const text = await readAsText(file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new LoadError(`${file.name} is not valid JSON.`);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new LoadError(`${file.name}: expected a JSON object.`);
  }

  const obj = parsed as Record<string, unknown>;
  if (obj['schema_version'] !== '1.0') {
    throw new LoadError(`Unsupported schema version "${String(obj['schema_version'])}". Expected "1.0".`);
  }
  if (!Array.isArray(obj['pages'])) throw new LoadError('Missing "pages" array.');
  if (!Array.isArray(obj['references'])) throw new LoadError('Missing "references" array.');
  if (!Array.isArray(obj['citation_maps'])) throw new LoadError('Missing "citation_maps" array.');
  if (!Array.isArray(obj['unresolved'])) throw new LoadError('Missing "unresolved" array.');

  return parsed as IngestionResult;
}

/** Parse and validate Resolved References JSON file (Phase 2). */
export async function loadResolvedReferences(file: File): Promise<Map<string, ResolvedPaper>> {
  const text = await readAsText(file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new LoadError(`${file.name} is not valid JSON.`);
  }

  if (!Array.isArray(parsed)) {
    throw new LoadError(`${file.name}: expected an array of {anchor_id, paper} records.`);
  }

  const map = new Map<string, ResolvedPaper>();
  for (const item of parsed as ResolvedRecord[]) {
    if (typeof item.anchor_id === 'string' && item.paper) {
      map.set(item.anchor_id, item.paper);
    }
  }
  return map;
}

/** Parse and validate Verification Verdicts JSON file (Phase 3). */
export async function loadVerificationVerdicts(file: File): Promise<Map<string, VerificationVerdict>> {
  const text = await readAsText(file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new LoadError(`${file.name} is not valid JSON.`);
  }

  if (!Array.isArray(parsed)) {
    throw new LoadError(`${file.name}: expected an array of VerificationVerdict objects.`);
  }

  const map = new Map<string, VerificationVerdict>();
  for (const item of parsed as VerificationVerdict[]) {
    if (item.claim_id && item.anchor_id) {
      map.set(`${item.claim_id}:${item.anchor_id}`, item);
    }
  }
  return map;
}

export interface DemoPayload {
  pdfBytes: ArrayBuffer;
  result: IngestionResult;
  resolvedMap: Map<string, ResolvedPaper>;
  verdictsMap: Map<string, VerificationVerdict>;
}

/** Load the bundled demo fixtures across all phases (Phase 1 + Phase 2 + Phase 3). */
export async function loadDemoFixture(): Promise<DemoPayload> {
  const [pdfResp, jsonResp, resolvedResp, verdictsResp] = await Promise.all([
    fetch('/examples/demo.pdf'),
    fetch('/examples/demo-result.json'),
    fetch('/examples/demo-resolved.json'),
    fetch('/examples/demo-verdicts.json'),
  ]);

  if (!pdfResp.ok) throw new LoadError('Could not load demo PDF from examples/demo.pdf');
  if (!jsonResp.ok) throw new LoadError('Could not load demo JSON from examples/demo-result.json');

  const [pdfBytes, resultText] = await Promise.all([pdfResp.arrayBuffer(), jsonResp.text()]);
  const result = JSON.parse(resultText) as IngestionResult;

  const resolvedMap = new Map<string, ResolvedPaper>();
  if (resolvedResp.ok) {
    try {
      const records = (await resolvedResp.json()) as ResolvedRecord[];
      for (const r of records) resolvedMap.set(r.anchor_id, r.paper);
    } catch {
      // optional
    }
  }

  const verdictsMap = new Map<string, VerificationVerdict>();
  if (verdictsResp.ok) {
    try {
      const verdicts = (await verdictsResp.json()) as VerificationVerdict[];
      for (const v of verdicts) verdictsMap.set(`${v.claim_id}:${v.anchor_id}`, v);
    } catch {
      // optional
    }
  }

  return { pdfBytes, result, resolvedMap, verdictsMap };
}
