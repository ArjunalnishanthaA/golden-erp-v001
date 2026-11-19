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
  showQr: boolean;
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
const JSQR_URL = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js';

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
  const cleanShop = (d.shopName || '-').replace(/[|\r\n]+/g, ' ').trim().slice(0, 45);
  return [
    `INV:${(d.invoiceNo || 'BILL').trim()}`,
    `AG:${agencyCode}`,
    `SHOP:${cleanShop}`,
    `DT:${(d.billDate || '-').trim()}`,
    `ITEMS:${(d.itemCount || '0').trim()}`,
    `TOT:${(d.totalAmount || '0').trim()}`,
    `NET:${(d.netAmount || d.totalAmount || '0').trim()}`,
    `ST:${d.status}`
  ].join('|');
}

function parseScannedQrText(raw: string, fallbackAgencyCode: string): ScannedBillRecord {
  const trimmed = raw.trim();
  const parts = trimmed.split('|');

  const getField = (prefix: string) => {
    const found = parts.find(p => p.toUpperCase().startsWith(prefix.toUpperCase() + ':'));
    return found ? found.slice(prefix.length + 1).trim() : '';
  };

  const inv = getField('INV') || parts[0]?.trim() || 'UNKNOWN-BILL';
  const ag = getField('AG') || fallbackAgencyCode;
  const shop = getField('SHOP') || '-';
  const dt = getField('DT') || new Date().toISOString().slice(0, 10);
  const items = getField('ITEMS') || '0';
  const tot = getField('TOT') || '0';
  const net = getField('NET') || tot || '0';
  const stRaw = getField('ST');
  const status: 'Unpaid' | 'Half' | 'Paid' =
    stRaw === 'Paid' || stRaw === 'Half' || stRaw === 'Unpaid' ? stRaw : 'Unpaid';

  return {
    rawText: trimmed,
    invoiceNo: inv,
    agencyCode: ag,
    shopName: shop,
    billDate: dt,
    itemCount: items,
    totalAmount: tot,
    netAmount: net,
    status,
    scannedAt: new Date().toLocaleTimeString()
  };
}

async function makeRealQrDataUrl(payload: string): Promise<string> {
  try {
    return await QRCode.toDataURL(payload, {
      width: 180,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: {
        dark: '#000000',
        light: '#ffffff'
      }
    });
  } catch (err) {
    console.error('QR generation failed:', err);
    return '';
  }
}

function parsePageTextDetails(
  rawText: string,
  fallbackInvoice: string,
  pageNum: number
): {
  details: BillDetails;
  isContinuationPage: boolean;
} {
  const compact = rawText.replace(/\s+/g, ' ').trim();

  const fracMatch = compact.match(/\b(\d+)\s*\/\s*(\d+)\b/);
  const currentSubPage = fracMatch ? parseInt(fracMatch[1], 10) : pageNum;
  const isContinuationPage = currentSubPage > 1;

  const invMatch = compact.match(
    /\b(\d{2}[A-Z]{3}_[A-Z0-9_]+|CG\d{4}[A-Z0-9]+|INV[-_:/]?\d+[A-Z0-9_-]*)\b/i
  );
  const invoiceNo = invMatch ? invMatch[1].toUpperCase() : `${fallbackInvoice}-B${pageNum}`;

  const shopMatch = compact.match(
    /Invoiced\s*To\s*:?\s*([A-Za-z0-9\s.&'/-]{2,45}?)(?=\s+(?:Tel|Ordered|Invoice|Item|Gross|Total|No\.|\d{7,}))/i
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

  const grossMatch = compact.match(
    /(?:Gross\s*Total|Sub\s*Total|Total\s*Amount)\s*:?\s*(?:Rs\.?|LKR)?\s*([\d,]+\.\d{2}|[\d,]+)/i
  );
  const netMatch = compact.match(
    /(?:Net\s*Total|Grand\s*Total|Total\s*Value|Net\s*Amount|Balance\s*Due)\s*:?\s*(?:Rs\.?|LKR)?\s*([\d,]+\.\d{2}|[\d,]+)/i
  );

  const netVal = netMatch ? netMatch[1].replace(/,/g, '') : '';
  const totVal = grossMatch ? grossMatch[1].replace(/,/g, '') : netVal;

  return {
    isContinuationPage,
    details: {
      invoiceNo,
      shopName,
      billDate,
      itemCount,
      totalAmount: totVal,
      netAmount: netVal || totVal,
      status: 'Unpaid'
    }
  };
}

export default function App() {
  const [agency, setAgency] = useState<'Mihintale' | 'Anuradhapura'>('Mihintale');
  const [tab, setTab] = useState<'pdf' | 'scan'>('pdf');
  const [docs, setDocs] = useState<UploadedPdfDoc[]>([]);
  const [printDoc, setPrintDoc] = useState<UploadedPdfDoc | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const qrImgInputRef = useRef<HTMLInputElement | null>(null);

  // System QR Scanner state
  const [cameraOn, setCameraOn] = useState(false);
  const [scanError, setScanError] = useState('');
  const [scannedBill, setScannedBill] = useState<ScannedBillRecord | null>(null);
  const [scanHistory, setScanHistory] = useState<ScannedBillRecord[]>([]);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const intervalRef = useRef<number | null>(null);

  const agencyCode = agency === 'Anuradhapura' ? 'CG0388' : 'CG0392';

  const stopCamera = () => {
    setCameraOn(false);
    if (intervalRef.current) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (videoRef.current && videoRef.current.srcObject) {
      const stream = videoRef.current.srcObject as MediaStream;
      stream.getTracks().forEach(t => t.stop());
      videoRef.current.srcObject = null;
    }
  };

  useEffect(() => {
    return () => stopCamera();
  }, []);

  const handleQrDecoded = (text: string) => {
    if (!text || !text.trim()) return;
    const record = parseScannedQrText(text, agencyCode);
    setScannedBill(record);
    setScanError('');
    setScanHistory(prev => {
      const withoutDup = prev.filter(
        x => !(x.invoiceNo === record.invoiceNo && x.rawText === record.rawText)
      );
      return [record, ...withoutDup].slice(0, 15);
    });
  };

  const startCameraScanner = async () => {
    setScanError('');
    setCameraOn(true);
    try {
      await loadScriptOnce(JSQR_URL).catch(() => {});
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } }
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }

      const BarcodeDetectorCtor = (window as any).BarcodeDetector;
      let nativeDetector: any = null;
      if (BarcodeDetectorCtor) {
        try {
          nativeDetector = new BarcodeDetectorCtor({ formats: ['qr_code'] });
        } catch {
          nativeDetector = null;
        }
      }

      if (intervalRef.current) window.clearInterval(intervalRef.current);
      intervalRef.current = window.setInterval(async () => {
        if (!videoRef.current || videoRef.current.readyState < 2) return;

        if (nativeDetector) {
          try {
            const codes = await nativeDetector.detect(videoRef.current);
            if (codes && codes.length > 0 && codes[0].rawValue) {
              handleQrDecoded(String(codes[0].rawValue));
              return;
            }
          } catch {
            // fallback to jsQR
          }
        }

        const jsQR = (window as any).jsQR;
        if (jsQR && canvasRef.current) {
          const c = canvasRef.current;
          const ctx = c.getContext('2d');
          const w = videoRef.current.videoWidth || 640;
          const h = videoRef.current.videoHeight || 480;
          c.width = w;
          c.height = h;
          if (ctx) {
            ctx.drawImage(videoRef.current, 0, 0, w, h);
            const imgData = ctx.getImageData(0, 0, w, h);
            const decoded = jsQR(imgData.data, imgData.width, imgData.height, {
              inversionAttempts: 'attemptBoth'
            });
            if (decoded && decoded.data) {
              handleQrDecoded(String(decoded.data));
            }
          }
        }
      }, 300);
    } catch (err) {
      console.error(err);
      setCameraOn(false);
      setScanError(
        'කැමරාව open කරගත නොහැක — Browser Camera Permission දී නැවත උත්සාහ කරන්න (හෝ "Upload QR Photo" භාවිත කරන්න).'
      );
    }
  };

  const handleScanQrImageFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setScanError('');
    try {
      await loadScriptOnce(JSQR_URL);
      const jsQR = (window as any).jsQR;
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const c = document.createElement('canvas');
          c.width = img.width;
          c.height = img.height;
          const ctx = c.getContext('2d');
          if (!ctx || !jsQR) {
            setScanError('QR image decode කිරීමට නොහැකි විය.');
            return;
          }
          ctx.drawImage(img, 0, 0);
          const data = ctx.getImageData(0, 0, c.width, c.height);
          const res = jsQR(data.data, data.width, data.height, {
            inversionAttempts: 'attemptBoth'
          });
          if (res && res.data) {
            handleQrDecoded(String(res.data));
          } else {
            setScanError('මෙම පින්තූරයෙන් QR කෝඩ් එක හඳුනාගත නොහැකි විය.');
          }
        };
        img.src = String(reader.result || '');
      };
      reader.readAsDataURL(file);
    } catch {
      setScanError('QR decoder load කිරීමට නොහැකි විය.');
    }
    e.target.value = '';
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

      const parsed = parsePageTextDetails(txt, baseInv, p);

      const isSameAsPrevInvoice =
        lastInvoiceSeen !== '' &&
        parsed.details.invoiceNo.toUpperCase() === lastInvoiceSeen.toUpperCase();
      const shouldShowQr = !parsed.isContinuationPage && !isSameAsPrevInvoice;

      lastInvoiceSeen = parsed.details.invoiceNo;

      const payload = buildFullBillQrPayload(agencyCode, parsed.details);
      const qrDataUrl = shouldShowQr ? await makeRealQrDataUrl(payload) : '';

      pages.push({
        pageNumber: p,
        imageUrl: canvas.toDataURL('image/jpeg', 0.86),
        showQr: shouldShowQr,
        qrDataUrl,
        qrPayload: payload,
        details: parsed.details
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
              showQr: true,
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
            const nextQr = p.showQr ? await makeRealQrDataUrl(nextPayload) : '';
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

  const togglePageQr = async (docId: string, pageNumber: number) => {
    const updated = await Promise.all(
      docs.map(async d => {
        if (d.id !== docId) return d;
        const nextPages = await Promise.all(
          d.pages.map(async p => {
            if (p.pageNumber !== pageNumber) return p;
            const nextShow = !p.showQr;
            const nextPayload = buildFullBillQrPayload(agencyCode, p.details);
            const nextQr = nextShow ? await makeRealQrDataUrl(nextPayload) : '';
            return {
              ...p,
              showQr: nextShow,
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
              const qrDataUrl = p.showQr ? await makeRealQrDataUrl(payload) : '';
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

  const qrPagesCount = (d: UploadedPdfDoc) => d.pages.filter(p => p.showQr).length;

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
        .grid3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 8px; }
        .grid2 { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; }
        @media (max-width: 640px) { .grid3, .grid2 { grid-template-columns: 1fr; } }
        .qr-card { background: #ffffff; color: #0f172a; border-radius: 8px; padding: 6px; text-align: center; width: 108px; flex-shrink: 0; }
        .qr-card img { width: 92px; height: 92px; display: block; margin: 0 auto; }
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
        .top-right-qr { position: absolute; top: 10px; right: 10px; background: #ffffff; border: 2px solid #000000; padding: 4px; z-index: 10; text-align: center; max-width: 106px; }
        .top-right-qr img { width: 88px; height: 88px; display: block; margin: 0 auto; }
        .top-right-qr div { font-size: 9px; font-family: monospace; font-weight: 700; color: #000; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
              onClick={() => {
                stopCamera();
                setTab('pdf');
              }}
            >
              1. PDF Bill & QR Print
            </button>
            <button
              className={tab === 'scan' ? 'btn' : 'btn-dark'}
              onClick={() => setTab('scan')}
            >
              2. Scan QR & View Bill Details
            </button>
          </div>
        </div>

        {tab === 'pdf' && (
          <div className="card no-print">
            <h2 style={{ margin: 0, fontSize: 16, color: '#fbbf24' }}>
              Per-Bill Scannable QR (All Bill Details Included • No 2nd-Page Overlap)
            </h2>
            <p className="sub">
              එක් එක් බිලේ පළමු පිටුවට පමණක් ඉහළ දකුණේ QR එක වැටේ. 2වෙනි පිටුවේ ඩේටා වැසෙන්නේ නැත.
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
              const firstQrPage = d.pages.find(p => p.showQr) || d.pages[0];
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
                                  totalAmount: firstQrPage.details.totalAmount || e.target.value
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
          <div className="card no-print">
            <h2 style={{ margin: 0, fontSize: 16, color: '#fbbf24' }}>
              System QR Scanner & Bill Details Viewer
            </h2>
            <p className="sub">
              කැමරාවෙන් හෝ QR පින්තූරයකින් බිලේ QR කෝඩ් එක scan කර, සියලු විස්තර මෙතැනින් බලා Paid / Half / Unpaid කරන්න.
            </p>

            <div className="row" style={{ marginTop: 12, justifyContent: 'flex-start' }}>
              {!cameraOn ? (
                <button className="btn" onClick={startCameraScanner}>
                  Turn On Camera Scanner
                </button>
              ) : (
                <button className="btn-red" onClick={stopCamera}>
                  Stop Camera
                </button>
              )}

              <button className="btn-dark" onClick={() => qrImgInputRef.current?.click()}>
                Upload QR Photo
              </button>
              <input
                ref={qrImgInputRef}
                type="file"
                accept="image/*"
                style={{ display: 'none' }}
                onChange={handleScanQrImageFile}
              />
            </div>

            {scanError && (
              <div style={{ marginTop: 10, color: '#fbbf24', fontSize: 12 }}>{scanError}</div>
            )}

            {cameraOn && (
              <div style={{ marginTop: 14, maxWidth: 380 }}>
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  style={{
                    width: '100%',
                    borderRadius: 12,
                    border: '2px solid #f59e0b',
                    background: '#000'
                  }}
                />
                <canvas ref={canvasRef} style={{ display: 'none' }} />
              </div>
            )}

            {scannedBill && (
              <div className="detail-box">
                <div className="row" style={{ marginBottom: 10 }}>
                  <strong style={{ color: '#34d399', fontSize: 14 }}>
                    Scanned Bill Details ({scannedBill.invoiceNo})
                  </strong>
                  <span style={{ fontSize: 11, color: '#94a3b8' }}>
                    Scanned at {scannedBill.scannedAt}
                  </span>
                </div>

                <div className="grid3">
                  <div className="detail-item">
                    <span>Invoice No</span>
                    <b>{scannedBill.invoiceNo}</b>
                  </div>
                  <div className="detail-item">
                    <span>Agency</span>
                    <b>{scannedBill.agencyCode}</b>
                  </div>
                  <div className="detail-item">
                    <span>Status</span>
                    <b>{scannedBill.status}</b>
                  </div>
                  <div className="detail-item">
                    <span>Shop / Customer</span>
                    <b>{scannedBill.shopName}</b>
                  </div>
                  <div className="detail-item">
                    <span>Bill Date</span>
                    <b>{scannedBill.billDate}</b>
                  </div>
                  <div className="detail-item">
                    <span>Items / Net Amount</span>
                    <b>
                      {scannedBill.itemCount} items • LKR {scannedBill.netAmount}
                    </b>
                  </div>
                </div>

                <div className="payload-box">Raw QR Data: {scannedBill.rawText}</div>

                <div className="row" style={{ marginTop: 12, justifyContent: 'flex-start' }}>
                  <button className="btn-green" onClick={() => updateScannedStatus('Paid')}>
                    Mark Paid
                  </button>
                  <button className="btn-amber" onClick={() => updateScannedStatus('Half')}>
                    Mark Half
                  </button>
                  <button className="btn-red" onClick={() => updateScannedStatus('Unpaid')}>
                    Mark Unpaid
                  </button>
                </div>
              </div>
            )}

            {scanHistory.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#cbd5e1', marginBottom: 8 }}>
                  Recently Scanned Bills ({scanHistory.length})
                </div>
                {scanHistory.map((item, i) => (
                  <div
                    key={`${item.invoiceNo}-${i}`}
                    onClick={() => setScannedBill(item)}
                    style={{
                      background: '#0f172a',
                      border: '1px solid #334155',
                      borderRadius: 8,
                      padding: '8px 12px',
                      marginBottom: 8,
                      cursor: 'pointer',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      fontSize: 12
                    }}
                  >
                    <div>
                      <b style={{ color: '#fbbf24' }}>{item.invoiceNo}</b> — {item.shopName} (LKR{' '}
                      {item.netAmount})
                    </div>
                    <span style={{ fontWeight: 700, color: '#34d399' }}>{item.status}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {printDoc && (
        <div className="modal-bg">
          <div className="modal-box">
            <div
              className="row no-print"
              style={{ paddingBottom: 10, borderBottom: '1px solid #e2e8f0' }}
            >
              <div>
                <strong style={{ fontSize: 14 }}>{printDoc.fileName}</strong>
                <div style={{ fontSize: 11, color: '#475569' }}>
                  {printDoc.pages.length} Pages total • {qrPagesCount(printDoc)} Bill QR(s) placed on bill start pages only
                </div>
              </div>
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
                <div
                  className="no-print"
                  style={{
                    padding: '6px 10px',
                    background: '#f8fafc',
                    borderBottom: '1px solid #e2e8f0',
                    display: 'flex',
                    flexWrap: 'wrap',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 8,
                    fontSize: 11
                  }}
                >
                  <span>
                    <b>Page {pg.pageNumber}</b> — {pg.details.invoiceNo}
                    {pg.details.netAmount ? ` | LKR ${pg.details.netAmount}` : ''}
                  </span>
                  <button
                    type="button"
                    className="btn-dark"
                    style={{ padding: '4px 10px', fontSize: 11 }}
                    onClick={() => togglePageQr(printDoc.id, pg.pageNumber)}
                  >
                    {pg.showQr ? 'Hide QR on this Page' : 'Show QR on this Page'}
                  </button>
                </div>

                {pg.showQr && pg.qrDataUrl && (
                  <div className="top-right-qr">
                    <img src={pg.qrDataUrl} alt={pg.details.invoiceNo} />
                    <div>{pg.details.invoiceNo}</div>
                  </div>
                )}

                {pg.imageUrl ? (
                  <img
                    className="bill-img"
                    src={pg.imageUrl}
                    alt={`${printDoc.fileName} Page ${pg.pageNumber}`}
                  />
                ) : (
                  <div style={{ padding: 32, textAlign: 'center', fontSize: 13 }}>
                    Page {pg.pageNumber} ({pg.details.invoiceNo})
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
