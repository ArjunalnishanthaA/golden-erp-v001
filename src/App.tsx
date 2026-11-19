import React, { useState, useRef, useEffect } from 'react';
import QRCode from 'qrcode';

interface BillDetails {
  invoiceNo: string;
  shopName: string;
  billDate: string;
  itemCount: string;
  totalAmount: string;
  netAmount: string;
  status: 'Unpaid' | 'Half' | 'Paid';
}

interface PdfPageItem {
  pageNumber: number;
  imageUrl: string;
  hasQr: boolean;
  qrDataUrl: string;
  qrPayload: string;
  details: BillDetails;
}

interface UploadedPdfDoc {
  id: string;
  fileName: string;
  dataUrl: string;
  pages: PdfPageItem[];
  loading: boolean;
  errorMsg?: string;
}

interface ScannedBillRecord {
  rawText: string;
  invoiceNo: string;
  agencyCode: string;
  shopName: string;
  billDate: string;
  itemCount: string;
  totalAmount: string;
  netAmount: string;
  status: 'Unpaid' | 'Half' | 'Paid';
  scannedAt: string;
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

function buildFullBillQrPayload(agencyCode: string, d: BillDetails): string {
  const cleanInv = (d.invoiceNo || 'BILL').trim().slice(0, 28);
  const cleanShop = (d.shopName || '-').replace(/[|\r\n]+/g, ' ').trim().slice(0, 24);
  const cleanDate = (d.billDate || '-').trim().slice(0, 12);
  const cleanNet = (d.netAmount || d.totalAmount || '0').trim().slice(0, 12);
  const cleanItems = (d.itemCount || '0').trim().slice(0, 5);
  return `${cleanInv}|${agencyCode}|${cleanShop}|${cleanDate}|${cleanItems}|${cleanNet}|${d.status}`;
}

function parseScannedQrText(raw: string, fallbackAgencyCode: string): ScannedBillRecord {
  const trimmed = raw.trim();
  const parts = trimmed.split('|').map(p => p.trim());

  const getField = (prefix: string) => {
    const found = parts.find(p => p.toUpperCase().startsWith(prefix.toUpperCase() + ':'));
    return found ? found.slice(prefix.length + 1).trim() : '';
  };

  const hasKeyFormat = trimmed.includes('INV:') || trimmed.includes('AG:');

  const inv = hasKeyFormat ? getField('INV') || 'UNKNOWN-BILL' : parts[0] || 'UNKNOWN-BILL';
  const ag = hasKeyFormat ? getField('AG') || fallbackAgencyCode : parts[1] || fallbackAgencyCode;
  const shop = hasKeyFormat ? getField('SHOP') || '-' : parts[2] || '-';
  const dt = hasKeyFormat
    ? getField('DT') || new Date().toISOString().slice(0, 10)
    : parts[3] || new Date().toISOString().slice(0, 10);
  const items = hasKeyFormat ? getField('ITEMS') || '0' : parts[4] || '0';
  const net = hasKeyFormat
    ? getField('NET') || getField('TOT') || '0'
    : parts[5] || '0';
  const stRaw = hasKeyFormat ? getField('ST') : parts[6] || 'Unpaid';

  const status: 'Unpaid' | 'Half' | 'Paid' =
    stRaw === 'Paid' || stRaw === 'Half' || stRaw === 'Unpaid' ? stRaw : 'Unpaid';

  return {
    rawText: trimmed,
    invoiceNo: inv,
    agencyCode: ag,
    shopName: shop,
    billDate: dt,
    itemCount: items,
    totalAmount: net,
    netAmount: net,
    status,
    scannedAt: new Date().toLocaleTimeString()
  };
}

async function makeRealQrDataUrl(payload: string): Promise<string> {
  try {
    const mod: any = QRCode;
    const toDataUrlFn = mod?.toDataURL || mod?.default?.toDataURL;
    if (typeof toDataUrlFn === 'function') {
      return await toDataUrlFn(payload, {
        width: 240,
        margin: 4,
        errorCorrectionLevel: 'M',
        color: {
          dark: '#000000',
          light: '#ffffff'
        }
      });
    }
    return '';
  } catch (err) {
    console.error('QR generation failed:', err);
    return '';
  }
}

function parsePageTextDetails(rawText: string, fallbackInvoice: string, pageNum: number): BillDetails {
  const compact = rawText.replace(/\s+/g, ' ').trim();

  const invMatch = compact.match(
    /\b(\d{2}[A-Z]{3}_[A-Z0-9_]+|CG\d{4}[A-Z0-9]+|INV[-_:/]?\d+[A-Z0-9_-]*)\b/i
  );
  const invoiceNo = invMatch ? invMatch[1].toUpperCase() : `${fallbackInvoice}-P${pageNum}`;

  const shopMatch = compact.match(
    /Invoiced\s*To\s*:?\s*([A-Za-z0-9\s.&'/-]{2,35}?)(?=\s+(?:Tel|Ordered|Invoice|Item|Gross|Total|No\.|\d{7,}))/i
  );
  const shopName = shopMatch ? shopMatch[1].trim() : '';

  const dateMatch = compact.match(
    /\b(\d{4}[-/]\d{2}[-/]\d{2}|\d{2}[-/]\d{2}[-/]\d{4}|\d{2}\s+[A-Za-z]{3}\s+\d{4})\b/
  );
  const billDate = dateMatch ? dateMatch[1] : new Date().toISOString().slice(0, 10);

  const itemsMatch = compact.match(
    /(?:Total\s*(?:No\.?\s*of\s*)?Items?|Item\s*Count|Qty\s*Total)\s*:?\s*(\d+)/i
  );
  const itemCount = itemsMatch ? itemsMatch[1] : '';

  const netMatch = compact.match(
    /(?:Net\s*Total|Grand\s*Total|Total\s*Value|Net\s*Amount|Balance\s*Due)\s*:?\s*(?:Rs\.?|LKR)?\s*([\d,]+\.\d{2}|[\d,]+)/i
  );
  const netVal = netMatch ? netMatch[1].replace(/,/g, '') : '';

  return {
    invoiceNo,
    shopName,
    billDate,
    itemCount,
    totalAmount: netVal,
    netAmount: netVal,
    status: 'Unpaid'
  };
}

export default function App() {
  const [agency, setAgency] = useState<'Mihintale' | 'Anuradhapura'>('Mihintale');
  const [tab, setTab] = useState<'pdf' | 'scan'>('pdf');
  const [docs, setDocs] = useState<UploadedPdfDoc[]>([]);
  const [printDoc, setPrintDoc] = useState<UploadedPdfDoc | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const [scannerInput, setScannerInput] = useState('');
  const [scanError, setScanError] = useState('');
  const [scannedBill, setScannedBill] = useState<ScannedBillRecord | null>(null);
  const [scanHistory, setScanHistory] = useState<ScannedBillRecord[]>([]);
  const scannerInputRef = useRef<HTMLInputElement | null>(null);

  const agencyCode = agency === 'Anuradhapura' ? 'CG0388' : 'CG0392';

  useEffect(() => {
    if (tab === 'scan') {
      const t = window.setTimeout(() => {
        scannerInputRef.current?.focus();
      }, 60);
      return () => window.clearTimeout(t);
    }
  }, [tab]);

  const handleQrDecoded = (text: string) => {
    if (!text || !text.trim()) return;
    const record = parseScannedQrText(text, agencyCode);
    setScannedBill(record);
    setScanError('');
    setScannerInput('');
    setScanHistory(prev => {
      const withoutDup = prev.filter(
        x => !(x.invoiceNo === record.invoiceNo && x.rawText === record.rawText)
      );
      return [record, ...withoutDup].slice(0, 15);
    });
    window.setTimeout(() => {
      scannerInputRef.current?.focus();
    }, 30);
  };

  const handleScannerKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (scannerInput.trim()) {
        handleQrDecoded(scannerInput);
      } else {
        setScanError('QR කෝඩ් එක scan කරන්න හෝ text එක enter කරන්න.');
      }
    }
  };

  const updateScannedStatus = (newStatus: 'Unpaid' | 'Half' | 'Paid') => {
    if (!scannedBill) return;
    const updated: ScannedBillRecord = { ...scannedBill, status: newStatus };
    setScannedBill(updated);
    setScanHistory(prev =>
      prev.map(x =>
        x.invoiceNo === updated.invoiceNo && x.rawText === updated.rawText ? updated : x
      )
    );
  };

  const renderPdfBills = async (dataUrl: string, baseInv: string): Promise<PdfPageItem[]> => {
    await loadScriptOnce(PDFJS_URL);
    const pdfjsLib = (window as any).pdfjsLib;
    if (!pdfjsLib) throw new Error('pdfjsLib unavailable');
    pdfjsLib.GlobalWorkerOptions.workerSrc = WORKER_URL;

    const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      bytes[i] = bin.charCodeAt(i);
    }

    const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
    const totalPages = pdf.numPages || 1;
    const pages: PdfPageItem[] = [];
    let lastInvoiceSeen = '';

    for (let p = 1; p <= totalPages; p++) {
      const page = await pdf.getPage(p);
      const vp = page.getViewport({ scale: 1.45 });
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

      const details = parsePageTextDetails(txt, baseInv, p);

      const isSameAsPrevInvoice =
        lastInvoiceSeen !== '' &&
        details.invoiceNo.toUpperCase() === lastInvoiceSeen.toUpperCase();
      const shouldHaveQr = !isSameAsPrevInvoice;

      lastInvoiceSeen = details.invoiceNo;

      const payload = buildFullBillQrPayload(agencyCode, details);
      const qrDataUrl = shouldHaveQr ? await makeRealQrDataUrl(payload) : '';

      pages.push({
        pageNumber: p,
        imageUrl: canvas.toDataURL('image/jpeg', 0.86),
        hasQr: shouldHaveQr,
        qrDataUrl,
        qrPayload: payload,
        details
      });
    }

    return pages;
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

        const initialDetails: BillDetails = {
          invoiceNo: baseInv,
          shopName: '',
          billDate: new Date().toISOString().slice(0, 10),
          itemCount: '',
          totalAmount: '',
          netAmount: '',
          status: 'Unpaid'
        };
        const initialPayload = buildFullBillQrPayload(agencyCode, initialDetails);
        const initialQr = await makeRealQrDataUrl(initialPayload);

        const newDoc: UploadedPdfDoc = {
          id,
          fileName: file.name,
          dataUrl: url,
          loading: true,
          pages: [
            {
              pageNumber: 1,
              imageUrl: '',
              hasQr: true,
              qrDataUrl: initialQr,
              qrPayload: initialPayload,
              details: initialDetails
            }
          ]
        };

        setDocs(prev => [newDoc, ...prev]);

        try {
          const pages = await renderPdfBills(url, baseInv);
          setDocs(prev =>
            prev.map(d => (d.id === id ? { ...d, pages, loading: false } : d))
          );
        } catch (err) {
          console.error(err);
          setDocs(prev =>
            prev.map(d =>
              d.id === id
                ? {
                    ...d,
                    loading: false,
                    errorMsg: 'PDF render කිරීමේදී ගැටලුවක් ඇති විය. නැවත උත්සාහ කරන්න.'
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

  const updatePageDetails = async (
    docId: string,
    pageNumber: number,
    patch: Partial<BillDetails>
  ) => {
    const updated = await Promise.all(
      docs.map(async d => {
        if (d.id !== docId) return d;
        const nextPages = await Promise.all(
          d.pages.map(async p => {
            if (p.pageNumber !== pageNumber) return p;
            const nextDetails: BillDetails = { ...p.details, ...patch };
            const nextPayload = buildFullBillQrPayload(agencyCode, nextDetails);
            const nextQr = p.hasQr ? await makeRealQrDataUrl(nextPayload) : '';
            return {
              ...p,
              details: nextDetails,
              qrPayload: nextPayload,
              qrDataUrl: nextQr
            };
          })
        );
        return { ...d, pages: nextPages };
      })
    );
    setDocs(updated);
    if (printDoc && printDoc.id === docId) {
      setPrintDoc(updated.find(x => x.id === docId) || null);
    }
  };

  useEffect(() => {
    if (docs.length === 0) return;
    let cancelled = false;
    (async () => {
      const refreshed = await Promise.all(
        docs.map(async d => ({
          ...d,
          pages: await Promise.all(
            d.pages.map(async p => {
              const payload = buildFullBillQrPayload(agencyCode, p.details);
              const qrDataUrl = p.hasQr ? await makeRealQrDataUrl(payload) : '';
              return { ...p, qrPayload: payload, qrDataUrl };
            })
          )
        }))
      );
      if (!cancelled) {
        setDocs(refreshed);
        if (printDoc) {
          setPrintDoc(refreshed.find(x => x.id === printDoc.id) || null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agency]);

  const qrPagesCount = (d: UploadedPdfDoc) => d.pages.filter(p => p.hasQr).length;

  return (
    <div className="erp-root">
      <style>{`
        * { box-sizing: border-box; }
        body { margin: 0; font-family: system-ui, -apple-system, sans-serif; background: #0f172a; color: #f1f5f9; }
        .erp-root { min-height: 100vh; padding: 16px; }
        .wrap { max-width: 980px; margin: 0 auto; }
        .card { background: #1e293b; border: 1px solid #334155; border-radius: 14px; padding: 16px; margin-bottom: 16px; }
        .row { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 10px; }
        .title { margin: 0; font-size: 22px; color: #fbbf24; font-weight: 800; }
        .sub { margin: 4px 0 0; font-size: 12px; color: #94a3b8; }
        .btn { background: #f59e0b; color: #0f172a; border: none; border-radius: 8px; padding: 8px 14px; font-weight: 700; font-size: 12px; cursor: pointer; }
        .btn:hover { background: #fbbf24; }
        .btn-dark { background: #334155; color: #f8fafc; border: 1px solid #475569; border-radius: 8px; padding: 7px 12px; font-weight: 700; font-size: 12px; cursor: pointer; }
        .btn-green { background: #16a34a; color: #fff; border: none; border-radius: 7px; padding: 6px 12px; font-weight: 700; font-size: 12px; cursor: pointer; }
        .btn-amber { background: #d97706; color: #fff; border: none; border-radius: 7px; padding: 6px 12px; font-weight: 700; font-size: 12px; cursor: pointer; }
        .btn-red { background: #dc2626; color: #fff; border: none; border-radius: 7px; padding: 6px 12px; font-weight: 700; font-size: 12px; cursor: pointer; }
        .drop { border: 2px dashed #f59e0b; background: #0f172a; border-radius: 12px; padding: 20px; text-align: center; margin-top: 10px; }
        .doc-box { background: #0f172a; border: 1px solid #334155; border-radius: 12px; padding: 14px; margin-top: 12px; }
        .inp { background: #1e293b; color: #f8fafc; border: 1px solid #475569; border-radius: 7px; padding: 6px 9px; font-size: 12px; width: 100%; }
        .scan-inp {
          background: #0f172a;
          color: #fbbf24;
          border: 2px solid #f59e0b;
          border-radius: 10px;
          padding: 12px 14px;
          font-size: 14px;
          font-family: monospace;
          font-weight: 700;
          width: 100%;
          outline: none;
        }
        .scan-inp:focus {
          border-color: #34d399;
          box-shadow: 0 0 0 3px rgba(52, 211, 153, 0.2);
        }
        .grid3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 8px; }
        @media (max-width: 640px) { .grid3 { grid-template-columns: 1fr; } }
        .qr-card { background: #ffffff; color: #0f172a; border-radius: 8px; padding: 6px; text-align: center; width: 118px; flex-shrink: 0; }
        .qr-card img { width: 104px; height: 104px; display: block; margin: 0 auto; }
        .qr-lbl { font-size: 9px; font-family: monospace; font-weight: 700; margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .payload-box { font-size: 10px; font-family: monospace; color: #93c5fd; background: #1e293b; padding: 6px 8px; border-radius: 6px; margin-top: 8px; word-break: break-all; }
        .detail-box { background: #0f172a; border: 1px solid #38bdf8; border-radius: 12px; padding: 14px; margin-top: 14px; }
        .detail-item { background: #1e293b; padding: 8px 10px; border-radius: 8px; font-size: 12px; }
        .detail-item span { color: #94a3b8; display: block; font-size: 10px; }
        .detail-item b { color: #f8fafc; font-size: 13px; }
        .modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,0.88); overflow-y: auto; padding: 16px; z-index: 99; }
        .modal-box { max-width: 840px; margin: 0 auto; background: #ffffff; color: #0f172a; border-radius: 12px; padding: 16px; }
        .page-sheet { position: relative; border: 1px solid #cbd5e1; margin-top: 14px; background: #fff; overflow: hidden; }
        .page-sheet img.bill-img { width: 100%; height: auto; display: block; }
        .top-right-qr {
          position: absolute;
          top: 56px;
          right: 68px;
          background: #ffffff;
          border: 2px solid #000000;
          padding: 6px;
          z-index: 10;
          text-align: center;
          width: 118px;
        }
        .top-right-qr img {
          width: 104px;
          height: 104px;
          display: block;
          margin: 0 auto;
        }
        .top-right-qr div {
          font-size: 9px;
          font-family: monospace;
          font-weight: 700;
          color: #000;
          margin-top: 2px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        @page { size: auto; margin: 0; }
        @media print {
          html, body { background: #fff !important; color: #000 !important; margin: 0 !important; padding: 0 !important; }
          .no-print { display: none !important; }
          .modal-bg { position: static !important; background: #fff !important; padding: 0 !important; overflow: visible !important; }
          .modal-box { max-width: 100% !important; padding: 0 !important; border-radius: 0 !important; box-shadow: none !important; }
          .page-sheet { border: none !important; margin: 0 !important; page-break-inside: avoid; break-inside: avoid; page-break-after: always; break-after: page; }
          .page-sheet:last-child { page-break-after: auto; break-after: auto; }
          .page-sheet img.bill-img { max-height: 98vh; width: auto; max-width: 100%; margin: 0 auto; }
          .top-right-qr { top: 56px !important; right: 68px !important; }
        }
      `}</style>

      <div className="wrap">
        <div className="card no-print">
          <div className="row">
            <div>
              <h1 className="title">GOLDEN DISTRIBUTORS ERP</h1>
              <p className="sub">
                Agency: <b>{agency} ({agencyCode})</b> | Owner: Egodagedara Arjunal Nishantha Kumara
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

          <div className="row" style={{ marginTop: 14, justifyContent: 'flex-start' }}>
            <button
              className={tab === 'pdf' ? 'btn' : 'btn-dark'}
              onClick={() => setTab('pdf')}
            >
              1. PDF Bill & QR Print
            </button>
            <button
              className={tab === 'scan' ? 'btn' : 'btn-dark'}
              onClick={() => setTab('scan')}
            >
              2. QR Scanner Enter & Bill Details
            </button>
          </div>
        </div>

        {tab === 'pdf' && (
          <div className="card no-print">
            <h2 style={{ margin: 0, fontSize: 16, color: '#fbbf24' }}>
              Per-Bill Scannable QR (All Bill Details Included • No 2nd-Page Overlap)
            </h2>
            <p className="sub">
              එක් එක් බිලේ පළමු පිටුවට පමණක් ඉබේම QR එක වැටේ. 2වෙනි පිටුවේ ඩේටා වැසෙන්නේ නැත.
            </p>

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
              const firstQrPage = d.pages.find(p => p.hasQr) || d.pages[0];
              return (
                <div key={d.id} className="doc-box">
                  <div className="row" style={{ alignItems: 'flex-start' }}>
                    <div style={{ flex: 1, minWidth: 240 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: '#34d399' }}>
                        {d.fileName}{' '}
                        {d.loading
                          ? '(Rendering pages & QRs...)'
                          : `(${d.pages.length} Pages • ${qrPagesCount(d)} Bill QRs)`}
                      </div>
                      {d.errorMsg && (
                        <div style={{ fontSize: 11, color: '#fbbf24', marginTop: 4 }}>{d.errorMsg}</div>
                      )}

                      {firstQrPage && (
                        <>
                          <div className="grid3">
                            <input
                              className="inp"
                              value={firstQrPage.details.invoiceNo}
                              onChange={e =>
                                updatePageDetails(d.id, firstQrPage.pageNumber, {
                                  invoiceNo: e.target.value
                                })
                              }
                              placeholder="Invoice No"
                            />
                            <input
                              className="inp"
                              value={firstQrPage.details.shopName}
                              onChange={e =>
                                updatePageDetails(d.id, firstQrPage.pageNumber, {
                                  shopName: e.target.value
                                })
                              }
                              placeholder="Shop / Customer"
                            />
                            <input
                              className="inp"
                              value={firstQrPage.details.billDate}
                              onChange={e =>
                                updatePageDetails(d.id, firstQrPage.pageNumber, {
                                  billDate: e.target.value
                                })
                              }
                              placeholder="Date"
                            />
                          </div>

                          <div className="grid3">
                            <input
                              className="inp"
                              value={firstQrPage.details.itemCount}
                              onChange={e =>
                                updatePageDetails(d.id, firstQrPage.pageNumber, {
                                  itemCount: e.target.value
                                })
                              }
                              placeholder="Items Count"
                            />
                            <input
                              className="inp"
                              value={firstQrPage.details.netAmount}
                              onChange={e =>
                                updatePageDetails(d.id, firstQrPage.pageNumber, {
                                  netAmount: e.target.value,
                                  totalAmount: e.target.value
                                })
                              }
                              placeholder="Net / Total (LKR)"
                            />
                            <select
                              className="inp"
                              value={firstQrPage.details.status}
                              onChange={e =>
                                updatePageDetails(d.id, firstQrPage.pageNumber, {
                                  status: e.target.value as 'Unpaid' | 'Half' | 'Paid'
                                })
                              }
                            >
                              <option value="Unpaid">Unpaid</option>
                              <option value="Half">Half</option>
                              <option value="Paid">Paid</option>
                            </select>
                          </div>

                          <div className="payload-box">QR Data: {firstQrPage.qrPayload}</div>
                        </>
                      )}
                    </div>

                    {firstQrPage?.qrDataUrl && (
                      <div className="qr-card">
                        <img src={firstQrPage.qrDataUrl} alt={firstQrPage.details.invoiceNo} />
                        <div className="qr-lbl">{firstQrPage.details.invoiceNo}</div>
                      </div>
                    )}
                  </div>

                  <div style={{ marginTop: 10, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                    <button className="btn" onClick={() => setPrintDoc(d)}>
                      Preview & Print ({d.pages.length || 1} Pages)
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {tab === 'scan' && (
          <div className
