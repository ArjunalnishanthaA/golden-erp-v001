import React, { useState, useRef, useEffect } from 'react';

interface PdfPageItem {
  pageNumber: number;
  imageUrl: string;
  qrDataUrl: string;
  invoiceNo: string;
  amount: string;
  status: 'Unpaid' | 'Half' | 'Paid';
}

interface UploadedPdfDoc {
  id: string;
  fileName: string;
  dataUrl: string;
  invoiceNo: string;
  amount: string;
  status: 'Unpaid' | 'Half' | 'Paid';
  pages: PdfPageItem[];
  loading: boolean;
  errorMsg?: string;
}

const PDFJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
const WORKER_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

function loadScriptOnce(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const prev = document.querySelector(`script[src="${src}"]`) as HTMLScriptElement | null;
    if (prev) {
      if (prev.dataset.ready === '1') return resolve();
      prev.addEventListener('load', () => resolve(), { once: true });
      prev.addEventListener('error', () => reject(new Error('Failed to load script')), { once: true });
      return;
    }
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    const t = window.setTimeout(() => reject(new Error('Script load timeout')), 15000);
    s.onload = () => {
      window.clearTimeout(t);
      s.dataset.ready = '1';
      resolve();
    };
    s.onerror = () => {
      window.clearTimeout(t);
      reject(new Error('Script load error'));
    };
    document.head.appendChild(s);
  });
}

// Local deterministic QR-like 2D barcode matrix renderer (no external API dependency)
function generateLocalQrDataUrl(payload: string, size = 160): string {
  const modules = 25;
  const grid: boolean[][] = Array.from({ length: modules }, () =>
    Array.from({ length: modules }, () => false)
  );

  const drawFinder = (r0: number, c0: number) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = r0 + r;
        const cc = c0 + c;
        if (rr < 0 || rr >= modules || cc < 0 || cc >= modules) continue;
        const isBorder = r === -1 || r === 7 || c === -1 || c === 7;
        const isOuter = r === 0 || r === 6 || c === 0 || c === 6;
        const isInner = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        grid[rr][cc] = !isBorder && (isOuter || isInner);
      }
    }
  };

  drawFinder(0, 0);
  drawFinder(0, modules - 7);
  drawFinder(modules - 7, 0);

  // Timing patterns
  for (let i = 8; i < modules - 8; i++) {
    grid[6][i] = i % 2 === 0;
    grid[i][6] = i % 2 === 0;
  }

  // Hash payload into bits
  const bytes: number[] = [];
  for (let i = 0; i < payload.length; i++) {
    bytes.push(payload.charCodeAt(i));
  }
  if (bytes.length === 0) bytes.push(65);

  let hash = 2166136261;
  for (const b of bytes) {
    hash ^= b;
    hash = Math.imul(hash, 16777619);
  }

  let bitIndex = 0;
  for (let r = 0; r < modules; r++) {
    for (let c = 0; c < modules; c++) {
      const inTopLeft = r < 8 && c < 8;
      const inTopRight = r < 8 && c >= modules - 8;
      const inBottomLeft = r >= modules - 8 && c < 8;
      const inTiming = r === 6 || c === 6;
      if (inTopLeft || inTopRight || inBottomLeft || inTiming) continue;

      const byteVal = bytes[bitIndex % bytes.length];
      const bitPos = (bitIndex + r * 3 + c * 7) % 8;
      const mix = ((hash >>> ((r + c) % 24)) ^ (byteVal >> bitPos) ^ (r * c)) & 1;
      grid[r][c] = mix === 1;
      bitIndex++;
    }
  }

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);

  const pad = Math.floor(size * 0.08);
  const cell = (size - pad * 2) / modules;

  ctx.fillStyle = '#000000';
  for (let r = 0; r < modules; r++) {
    for (let c = 0; c < modules; c++) {
      if (grid[r][c]) {
        ctx.fillRect(
          Math.round(pad + c * cell),
          Math.round(pad + r * cell),
          Math.ceil(cell),
          Math.ceil(cell)
        );
      }
    }
  }

  return canvas.toDataURL('image/png');
}

export default function App() {
  const [agency, setAgency] = useState<'Mihintale' | 'Anuradhapura'>('Mihintale');
  const [docs, setDocs] = useState<UploadedPdfDoc[]>([]);
  const [printDoc, setPrintDoc] = useState<UploadedPdfDoc | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const code = agency === 'Anuradhapura' ? 'CG0388' : 'CG0392';

  const buildPayload = (
    invoiceNo: string,
    pageNum: number,
    amount: string,
    status: string
  ) => `${invoiceNo || 'BILL'}|P${pageNum}|${code}|${amount || 0}|${status}`;

  const renderPdfPages = async (
    dataUrl: string,
    baseInv: string,
    defaultAmount: string,
    defaultStatus: 'Unpaid' | 'Half' | 'Paid'
  ): Promise<PdfPageItem[]> => {
    await loadScriptOnce(PDFJS_URL);
    const pdfjsLib = (window as any).pdfjsLib;
    if (!pdfjsLib) throw new Error('pdfjsLib not available');
    pdfjsLib.GlobalWorkerOptions.workerSrc = WORKER_URL;

    const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      bytes[i] = bin.charCodeAt(i);
    }

    const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
    const total = pdf.numPages || 1;
    const out: PdfPageItem[] = [];

    for (let p = 1; p <= total; p++) {
      const page = await pdf.getPage(p);
      const vp = page.getViewport({ scale: 1.4 });
      const canvas = document.createElement('canvas');
      canvas.width = vp.width;
      canvas.height = vp.height;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
      }

      let txt = '';
      try {
        const tc = await page.getTextContent();
        txt = (tc.items || []).map((it: any) => it.str || '').join(' ');
      } catch {
        txt = '';
      }

      const invMatch = txt.match(/\b(\d{2}[A-Z]{3}_[A-Z0-9_]+|CG\d{4}[A-Z0-9]+)\b/i);
      const amtMatch = txt.match(
        /(?:Total\s*Value|Net\s*Total|Grand\s*Total)\s*:?\s*(?:Rs\.?|LKR)?\s*([\d,]+\.\d{2}|[\d,]+)/i
      );

      const pageInv = invMatch ? invMatch[1].toUpperCase() : `${baseInv}-P${p}`;
      const pageAmt = amtMatch ? amtMatch[1].replace(/,/g, '') : defaultAmount;
      const payload = buildPayload(pageInv, p, pageAmt, defaultStatus);

      out.push({
        pageNumber: p,
        imageUrl: canvas.toDataURL('image/jpeg', 0.85),
        qrDataUrl: generateLocalQrDataUrl(payload, 160),
        invoiceNo: pageInv,
        amount: pageAmt,
        status: defaultStatus
      });
    }

    return out;
  };

  const onFilePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || !files.length) return;

    Array.from(files).forEach((file, idx) => {
      const reader = new FileReader();
      reader.onload = async () => {
        const url = typeof reader.result === 'string' ? reader.result : '';
        if (!url) return;

        const clean = file.name.replace(/\.[^/.]+$/, '');
        const invGuess = clean.match(/(?:CG\d{4}[A-Z0-9]+|\d{2}[A-Z]{3}_[A-Z0-9_]+)/i);
        const baseInv = invGuess ? invGuess[0].toUpperCase() : clean || `BILL-${idx + 1}`;
        const id = `${Date.now()}-${idx}`;
        const initialQr = generateLocalQrDataUrl(buildPayload(baseInv, 1, '', 'Unpaid'), 160);

        const item: UploadedPdfDoc = {
          id,
          fileName: file.name,
          dataUrl: url,
          invoiceNo: baseInv,
          amount: '',
          status: 'Unpaid',
          pages: [
            {
              pageNumber: 1,
              imageUrl: '',
              qrDataUrl: initialQr,
              invoiceNo: baseInv,
              amount: '',
              status: 'Unpaid'
            }
          ],
          loading: true
        };

        setDocs(prev => [item, ...prev]);

        try {
          const pages = await renderPdfPages(url, baseInv, '', 'Unpaid');
          setDocs(prev =>
            prev.map(d =>
              d.id === id
                ? {
                    ...d,
                    pages,
                    loading: false,
                    invoiceNo: pages[0]?.invoiceNo || d.invoiceNo,
                    amount: pages[0]?.amount || d.amount
                  }
                : d
            )
          );
        } catch (err) {
          console.error(err);
          setDocs(prev =>
            prev.map(d =>
              d.id === id
                ? {
                    ...d,
                    loading: false,
                    errorMsg:
                      'PDF.js load වීමේ ගැටලුවක් — Page 1 QR සකසා ඇත. Internet connection එක පරීක්ෂා කර නැවත upload කරන්න.'
                  }
                : d
            )
          );
        }
      };
      reader.readAsDataURL(file);
    });

    e.target.value = '';
  };

  const updateDocField = (
    id: string,
    key: 'invoiceNo' | 'amount' | 'status',
    val: string
  ) => {
    setDocs(prev =>
      prev.map(d => {
        if (d.id !== id) return d;
        const nextDoc = { ...d, [key]: val };
        const nextPages = d.pages.map(p => {
          const pInv = key === 'invoiceNo' && d.pages.length === 1 ? val : p.invoiceNo;
          const pAmt = key === 'amount' ? val : p.amount;
          const pSt = (key === 'status' ? val : p.status) as 'Unpaid' | 'Half' | 'Paid';
          return {
            ...p,
            invoiceNo: pInv,
            amount: pAmt,
            status: pSt,
            qrDataUrl: generateLocalQrDataUrl(buildPayload(pInv, p.pageNumber, pAmt, pSt), 160)
          };
        });
        return { ...nextDoc, pages: nextPages };
      })
    );
  };

  // Refresh QR codes when agency changes
  useEffect(() => {
    setDocs(prev =>
      prev.map(d => ({
        ...d,
        pages: d.pages.map(p => ({
          ...p,
          qrDataUrl: generateLocalQrDataUrl(
            buildPayload(p.invoiceNo, p.pageNumber, p.amount, p.status),
            160
          )
        }))
      }))
    );
  }, [agency]);

  return (
    <div className="erp-root">
      <style>{`
        * { box-sizing: border-box; }
        body { margin: 0; font-family: system-ui, -apple-system, sans-serif; background: #0f172a; color: #f1f5f9; }
        .erp-root { min-height: 100vh; padding: 16px; }
        .wrap { max-width: 960px; margin: 0 auto; }
        .card { background: #1e293b; border: 1px solid #334155; border-radius: 14px; padding: 16px; margin-bottom: 16px; }
        .row { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 10px; }
        .title { margin: 0; font-size: 22px; color: #fbbf24; font-weight: 800; }
        .sub { margin: 4px 0 0; font-size: 12px; color: #94a3b8; }
        .btn { background: #f59e0b; color: #0f172a; border: none; border-radius: 8px; padding: 8px 14px; font-weight: 700; font-size: 12px; cursor: pointer; }
        .btn:hover { background: #fbbf24; }
        .btn-dark { background: #334155; color: #f8fafc; border: 1px solid #475569; border-radius: 8px; padding: 7px 12px; font-weight: 700; font-size: 12px; cursor: pointer; }
        .drop { border: 2px dashed #f59e0b; background: #0f172a; border-radius: 12px; padding: 20px; text-align: center; margin-top: 10px; }
        .doc-box { background: #0f172a; border: 1px solid #334155; border-radius: 12px; padding: 14px; margin-top: 12px; }
        .inp { background: #1e293b; color: #f8fafc; border: 1px solid #475569; border-radius: 7px; padding: 7px 10px; font-size: 12px; width: 100%; }
        .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 8px; }
        .qr-card { background: #ffffff; color: #0f172a; border-radius: 8px; padding: 6px; text-align: center; width: 98px; flex-shrink: 0; }
        .qr-card img { width: 86px; height: 86px; display: block; margin: 0 auto; }
        .qr-lbl { font-size: 9px; font-family: monospace; font-weight: 700; margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,0.88); overflow-y: auto; padding: 16px; z-index: 99; }
        .modal-box { max-width: 820px; margin: 0 auto; background: #ffffff; color: #0f172a; border-radius: 12px; padding: 16px; }
        .page-sheet { position: relative; border: 1px solid #cbd5e1; margin-top: 14px; background: #fff; }
        .page-sheet img.bill-img { width: 100%; height: auto; display: block; }
        .top-right-qr { position: absolute; top: 8px; right: 8px; background: #fff; border: 2px solid #000; padding: 4px; z-index: 10; text-align: center; }
        .top-right-qr img { width: 88px; height: 88px; display: block; }
        .top-right-qr div { font-size: 9px; font-family: monospace; font-weight: 700; color: #000; }
        @page { size: auto; margin: 0; }
        @media print {
          html, body { background: #fff !important; color: #000 !important; margin: 0 !important; padding: 0 !important; }
          .no-print { display: none !important; }
          .modal-bg { position: static !important; background: #fff !important; padding: 0 !important; overflow: visible !important; }
          .modal-box { max-width: 100% !important; padding: 0 !important; border-radius: 0 !important; box-shadow: none !important; }
          .page-sheet { border: none !important; margin: 0 !important; page-break-inside: avoid; break-inside: avoid; page-break-after: always; break-after: page; }
          .page-sheet:last-child { page-break-after: auto; break-after: auto; }
          .page-sheet img.bill-img { max-height: 98vh; width: auto; max-width: 100%; margin: 0 auto; }
        }
      `}</style>

      <div className="wrap">
        <div className="card no-print">
          <div className="row">
            <div>
              <h1 className="title">GOLDEN DISTRIBUTORS ERP</h1>
              <p className="sub">
                Agency: <b>{agency} ({code})</b> | Owner: Egodagedara Arjunal Nishantha Kumara
              </p>
            </div>
            <div className="row">
              <button
                className={agency === 'Mihintale' ? 'btn' : 'btn-dark'}
                onClick={() => setAgency('Mihintale')}
              >
                Mihintale (CG0392)
              </button>
              <button
                className={agency === 'Anuradhapura' ? 'btn' : 'btn-dark'}
                onClick={() => setAgency('Anuradhapura')}
              >
                Anuradhapura (CG0388)
              </button>
            </div>
          </div>
        </div>

        <div className="card no-print">
          <h2 style={{ margin: 0, fontSize: 16, color: '#fbbf24' }}>
            PDF Bill Upload & Top-Right QR Print
          </h2>
          <div className="drop">
            <p style={{ margin: '0 0 10px', fontSize: 13 }}>PDF බිල් ෆයිලය තෝරන්න:</p>
            <input
              ref={fileRef}
              type="file"
              accept=".pdf,application/pdf"
              multiple
              onChange={onFilePick}
            />
          </div>

          {docs.map(d => {
            const firstQr = d.pages[0]?.qrDataUrl || generateLocalQrDataUrl(buildPayload(d.invoiceNo, 1, d.amount, d.status), 160);
            return (
              <div key={d.id} className="doc-box">
                <div className="row" style={{ alignItems: 'flex-start' }}>
                  <div style={{ flex: 1, minWidth: 220 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: '#34d399' }}>
                      {d.fileName}{' '}
                      {d.loading
                        ? '(Rendering pages...)'
                        : d.pages.length > 0 && d.pages[0].imageUrl
                        ? `(${d.pages.length} Pages Ready)`
                        : ''}
                    </div>
                    {d.errorMsg && (
                      <div style={{ fontSize: 11, color: '#fbbf24', marginTop: 4 }}>{d.errorMsg}</div>
                    )}
                    <div className="grid2">
                      <input
                        className="inp"
                        value={d.invoiceNo}
                        onChange={e => updateDocField(d.id, 'invoiceNo', e.target.value)}
                        placeholder="Invoice No"
                      />
                      <input
                        className="inp"
                        value={d.amount}
                        onChange={e => updateDocField(d.id, 'amount', e.target.value)}
                        placeholder="Amount (LKR)"
                      />
                    </div>
                    <div style={{ marginTop: 8 }}>
                      <select
                        className="inp"
                        value={d.status}
                        onChange={e => updateDocField(d.id, 'status', e.target.value)}
                      >
                        <option value="Unpaid">Unpaid</option>
                        <option value="Half">Half</option>
                        <option value="Paid">Paid</option>
                      </select>
                    </div>
                  </div>

                  <div className="qr-card">
                    <img src={firstQr} alt={d.invoiceNo} />
                    <div className="qr-lbl">{d.invoiceNo}</div>
                  </div>
                </div>

                <div style={{ marginTop: 10, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                  <button className="btn" onClick={() => setPrintDoc(d)}>
                    Preview & Print ({d.pages.length || 1})
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {printDoc && (
        <div className="modal-bg">
          <div className="modal-box">
            <div
              className="row no-print"
              style={{ paddingBottom: 10, borderBottom: '1px solid #e2e8f0' }}
            >
              <strong style={{ fontSize: 14 }}>
                {printDoc.fileName} — {printDoc.pages.length} Page(s)
              </strong>
              <div className="row">
                <button className="btn" onClick={() => window.print()}>
                  Print Now
                </button>
                <button className="btn-dark" onClick={() => setPrintDoc(null)}>
                  Close
                </button>
              </div>
            </div>

            {printDoc.pages.map(pg => (
              <div key={pg.pageNumber} className="page-sheet">
                <div className="top-right-qr">
                  <img src={pg.qrDataUrl} alt={pg.invoiceNo} />
                  <div>{pg.invoiceNo}</div>
                </div>
                {pg.imageUrl ? (
                  <img
                    className="bill-img"
                    src={pg.imageUrl}
                    alt={`${printDoc.fileName} Page ${pg.pageNumber}`}
                  />
                ) : (
                  <div style={{ padding: 32, textAlign: 'center', fontSize: 13 }}>
                    Page {pg.pageNumber} ({pg.invoiceNo}) — PDF image render වන තෙක් රැඳී සිටින්න.
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
