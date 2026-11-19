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
const JSQR_URL = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js';

function loadScriptOnce(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const prev = document.querySelector(`script[src="${src}"]`) as HTMLScriptElement \vert{} null; if (prev) { if (prev.dataset.ready === '1') return resolve(); prev.addEventListener('load', () => resolve(), { once: true }); prev.addEventListener('error', () => reject(new Error('Failed to load script')), { once: true }); return; } const s = document.createElement('script'); s.src = src; s.async = true; const t = window.setTimeout(() => reject(new Error('Script load timeout')), 15000); s.onload = () => { window.clearTimeout(t); s.dataset.ready = '1'; resolve(); }; s.onerror = () => { window.clearTimeout(t); reject(new Error('Script load error')); }; document.head.appendChild(s); }); }  function buildFullBillQrPayload(agencyCode: string, d: BillDetails): string { const cleanShop = (d.shopName \vert{}\vert{} '-').replace(/[\vert{}\r\n]+/g, ' ').trim().slice(0, 45); return [ `INV:${(d.invoiceNo || 'BILL').trim()}`,
    `AG:${agencyCode}`, `SHOP:${cleanShop}`,
    `DT:${(d.billDate \vert{}\vert{} '-').trim()}`, `ITEMS:${(d.itemCount || '0').trim()}`,
    `TOT:${(d.totalAmount \vert{}\vert{} '0').trim()}`, `NET:${(d.netAmount || d.totalAmount || '0').trim()}`,
    `ST:${d.status}` ].join('\vert{}'); }  function parseScannedQrText(raw: string, fallbackAgencyCode: string): ScannedBillRecord { const trimmed = raw.trim(); const parts = trimmed.split('\vert{}');  const getField = (prefix: string) => { const found = parts.find(p => p.toUpperCase().startsWith(prefix.toUpperCase() + ':')); return found ? found.slice(prefix.length + 1).trim() : ''; };  const inv = getField('INV') \vert{}\vert{} parts[0]?.trim() \vert{}\vert{} 'UNKNOWN-BILL'; const ag = getField('AG') \vert{}\vert{} fallbackAgencyCode; const shop = getField('SHOP') \vert{}\vert{} '-'; const dt = getField('DT') \vert{}\vert{} new Date().toISOString().slice(0, 10); const items = getField('ITEMS') \vert{}\vert{} '0'; const tot = getField('TOT') \vert{}\vert{} '0'; const net = getField('NET') \vert{}\vert{} tot \vert{}\vert{} '0'; const stRaw = getField('ST'); const status: 'Unpaid' \vert{} 'Half' \vert{} 'Paid' = stRaw === 'Paid' \vert{}\vert{} stRaw === 'Half' \vert{}\vert{} stRaw === 'Unpaid' ? stRaw : 'Unpaid';  return { rawText: trimmed, invoiceNo: inv, agencyCode: ag, shopName: shop, billDate: dt, itemCount: items, totalAmount: tot, netAmount: net, status, scannedAt: new Date().toLocaleTimeString() }; }  async function makeRealQrDataUrl(payload: string): Promise<string> { try { return await QRCode.toDataURL(payload, { width: 220, margin: 3, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } }); } catch (err) { console.error('QR generation failed:', err); return ''; } }  function parsePageTextDetails(rawText: string, fallbackInvoice: string, pageNum: number): BillDetails { const compact = rawText.replace(/\s+/g, ' ').trim();  const invMatch = compact.match( /\b(\d{2}[A-Z]{3}_[A-Z0-9_]+\vert{}CG\d{4}[A-Z0-9]+\vert{}INV[-_:/]?\d+[A-Z0-9_-]*)\b/i ); const invoiceNo = invMatch ? invMatch[1].toUpperCase() : `${fallbackInvoice}-P${pageNum}`;  const shopMatch = compact.match( /Invoiced\s*To\s*:?\s*([A-Za-z0-9\s.&'/-]{2,45}?)(?=\s+(?:Tel\vert{}Ordered\vert{}Invoice\vert{}Item\vert{}Gross\vert{}Total\vert{}No\.\vert{}\d{7,}))/i ); const shopName = shopMatch ? shopMatch[1].trim() : '';  const dateMatch = compact.match( /\b(\d{4}[-/]\d{2}[-/]\d{2}\vert{}\d{2}[-/]\d{2}[-/]\d{4}\vert{}\d{2}\s+[A-Za-z]{3}\s+\d{4})\b/ ); const billDate = dateMatch ? dateMatch[1] : new Date().toISOString().slice(0, 10);  const itemsMatch = compact.match( /(?:Total\s*(?:No\.?\s*of\s*)?Items?\vert{}Item\s*Count\vert{}Qty\s*Total)\s*:?\s*(\d+)/i ); const itemCount = itemsMatch ? itemsMatch[1] : '';  const grossMatch = compact.match( /(?:Gross\s*Total\vert{}Sub\s*Total\vert{}Total\s*Amount)\s*:?\s*(?:Rs\.?\vert{}LKR)?\s*([\d,]+\.\d{2}\vert{}[\d,]+)/i ); const netMatch = compact.match( /(?:Net\s*Total\vert{}Grand\s*Total\vert{}Total\s*Value\vert{}Net\s*Amount\vert{}Balance\s*Due)\s*:?\s*(?:Rs\.?\vert{}LKR)?\s*([\d,]+\.\d{2}\vert{}[\d,]+)/i );  const netVal = netMatch ? netMatch[1].replace(/,/g, '') : ''; const totVal = grossMatch ? grossMatch[1].replace(/,/g, '') : netVal;  return { invoiceNo, shopName, billDate, itemCount, totalAmount: totVal, netAmount: netVal \vert{}\vert{} totVal, status: 'Unpaid' }; }  export default function App() { const [agency, setAgency] = useState<'Mihintale' \vert{} 'Anuradhapura'>('Mihintale'); const [tab, setTab] = useState<'pdf' \vert{} 'scan'>('pdf'); const [docs, setDocs] = useState<UploadedPdfDoc[]>([]); const [printDoc, setPrintDoc] = useState<UploadedPdfDoc \vert{} null>(null); const fileRef = useRef<HTMLInputElement \vert{} null>(null); const qrImgInputRef = useRef<HTMLInputElement \vert{} null>(null);  const [cameraOn, setCameraOn] = useState(false); const [scanError, setScanError] = useState(''); const [scannedBill, setScannedBill] = useState<ScannedBillRecord \vert{} null>(null); const [scanHistory, setScanHistory] = useState<ScannedBillRecord[]>([]); const videoRef = useRef<HTMLVideoElement \vert{} null>(null); const canvasRef = useRef<HTMLCanvasElement \vert{} null>(null); const intervalRef = useRef<number \vert{} null>(null);  const agencyCode = agency === 'Anuradhapura' ? 'CG0388' : 'CG0392';  const stopCamera = () => { setCameraOn(false); if (intervalRef.current) { window.clearInterval(intervalRef.current); intervalRef.current = null; } if (videoRef.current && videoRef.current.srcObject) { const stream = videoRef.current.srcObject as MediaStream; stream.getTracks().forEach(t => t.stop()); videoRef.current.srcObject = null; } };  useEffect(() => { return () => stopCamera(); }, []);  const handleQrDecoded = (text: string) => { if (!text \vert{}\vert{} !text.trim()) return; const record = parseScannedQrText(text, agencyCode); setScannedBill(record); setScanError(''); setScanHistory(prev => { const withoutDup = prev.filter( x => !(x.invoiceNo === record.invoiceNo && x.rawText === record.rawText) ); return [record, ...withoutDup].slice(0, 15); }); };  const startCameraScanner = async () => { setScanError(''); setCameraOn(true); try { await loadScriptOnce(JSQR_URL).catch(() => {}); const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } } }); if (videoRef.current) { videoRef.current.srcObject = stream; await videoRef.current.play(); }  const BarcodeDetectorCtor = (window as any).BarcodeDetector; let nativeDetector: any = null; if (BarcodeDetectorCtor) { try { nativeDetector = new BarcodeDetectorCtor({ formats: ['qr_code'] }); } catch { nativeDetector = null; } }  if (intervalRef.current) window.clearInterval(intervalRef.current); intervalRef.current = window.setInterval(async () => { if (!videoRef.current \vert{}\vert{} videoRef.current.readyState < 2) return;  if (nativeDetector) { try { const codes = await nativeDetector.detect(videoRef.current); if (codes && codes.length > 0 && codes[0].rawValue) { handleQrDecoded(String(codes[0].rawValue)); return; } } catch { // fallback to jsQR } }  const jsQR = (window as any).jsQR; if (jsQR && canvasRef.current) { const c = canvasRef.current; const ctx = c.getContext('2d'); const w = videoRef.current.videoWidth \vert{}\vert{} 640; const h = videoRef.current.videoHeight \vert{}\vert{} 480; c.width = w; c.height = h; if (ctx) { ctx.drawImage(videoRef.current, 0, 0, w, h); const imgData = ctx.getImageData(0, 0, w, h); const decoded = jsQR(imgData.data, imgData.width, imgData.height, { inversionAttempts: 'attemptBoth' }); if (decoded && decoded.data) { handleQrDecoded(String(decoded.data)); } } } }, 300); } catch (err) { console.error(err); setCameraOn(false); setScanError( 'කැමරාව open කරගත නොහැක — Browser Camera Permission දී නැවත උත්සාහ කරන්න (හෝ "Upload QR Photo" භාවිත කරන්න).' ); } };  const handleScanQrImageFile = async (e: React.ChangeEvent<HTMLInputElement>) => { const file = e.target.files?.[0]; if (!file) return; setScanError(''); try { await loadScriptOnce(JSQR_URL); const jsQR = (window as any).jsQR; const reader = new FileReader(); reader.onload = () => { const img = new Image(); img.onload = () => { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const ctx = c.getContext('2d'); if (!ctx \vert{}\vert{} !jsQR) { setScanError('QR image decode කිරීමට නොහැකි විය.'); return; } ctx.drawImage(img, 0, 0); const data = ctx.getImageData(0, 0, c.width, c.height); const res = jsQR(data.data, data.width, data.height, { inversionAttempts: 'attemptBoth' }); if (res && res.data) { handleQrDecoded(String(res.data)); } else { setScanError('මෙම පින්තූරයෙන් QR කෝඩ් එක හඳුනාගත නොහැකි විය.'); } }; img.src = String(reader.result \vert{}\vert{} ''); }; reader.readAsDataURL(file); } catch { setScanError('QR decoder load කිරීමට නොහැකි විය.'); } e.target.value = ''; };  const updateScannedStatus = (newStatus: 'Unpaid' \vert{} 'Half' \vert{} 'Paid') => { if (!scannedBill) return; const updated: ScannedBillRecord = { ...scannedBill, status: newStatus }; setScannedBill(updated); setScanHistory(prev => prev.map(x => x.invoiceNo === updated.invoiceNo && x.rawText === updated.rawText ? updated : x ) ); };  const renderPdfBills = async (dataUrl: string, baseInv: string): Promise<PdfPageItem[]> => { await loadScriptOnce(PDFJS_URL); const pdfjsLib = (window as any).pdfjsLib; if (!pdfjsLib) throw new Error('pdfjsLib unavailable'); pdfjsLib.GlobalWorkerOptions.workerSrc = WORKER_URL;  const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl; const bin = atob(base64); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) { bytes[i] = bin.charCodeAt(i); }  const pdf = await pdfjsLib.getDocument({ data: bytes }).promise; const totalPages = pdf.numPages \vert{}\vert{} 1; const pages: PdfPageItem[] = []; let lastInvoiceSeen = '';  for (let p = 1; p <= totalPages; p++) { const page = await pdf.getPage(p); const vp = page.getViewport({ scale: 1.45 }); const canvas = document.createElement('canvas'); canvas.width = vp.width; canvas.height = vp.height; const ctx = canvas.getContext('2d'); if (ctx) { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height); await page.render({ canvasContext: ctx, viewport: vp }).promise; }  let txt = ''; try { const tc = await page.getTextContent(); txt = (tc.items \vert{}\vert{} []).map((it: any) => it.str \vert{}\vert{} '').join(' '); } catch { txt = ''; }  const details = parsePageTextDetails(txt, baseInv, p);  // Put QR on each bill's first page automatically; skip continuation pages with identical invoiceNo const isSameAsPrevInvoice = lastInvoiceSeen !== '' && details.invoiceNo.toUpperCase() === lastInvoiceSeen.toUpperCase(); const shouldHaveQr = !isSameAsPrevInvoice;  lastInvoiceSeen = details.invoiceNo;  const payload = buildFullBillQrPayload(agencyCode, details); const qrDataUrl = shouldHaveQr ? await makeRealQrDataUrl(payload) : '';  pages.push({ pageNumber: p, imageUrl: canvas.toDataURL('image/jpeg', 0.86), hasQr: shouldHaveQr, qrDataUrl, qrPayload: payload, details }); }  return pages; };  const onFilePick = (e: React.ChangeEvent<HTMLInputElement>) => { const files = e.target.files; if (!files \vert{}\vert{} !files.length) return;  Array.from(files).forEach((file, idx) => { const reader = new FileReader(); reader.onload = async () => { const url = typeof reader.result === 'string' ? reader.result : ''; if (!url) return;  const clean = file.name.replace(/\.[^/.]+$/, ''); const invGuess = clean.match(/(?:CG\d{4}[A-Z0-9]+\vert{}\d{2}[A-Z]{3}_[A-Z0-9_]+)/i); const baseInv = invGuess ? invGuess[0].toUpperCase() : clean \vert{}\vert{} `BILL-${idx + 1}`;
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
        .btn { background: #f59e0b; color: #0f172a; border: none; border-radius: 8px; padding: 8px 14px; font-weight: 700; font-size: 1
