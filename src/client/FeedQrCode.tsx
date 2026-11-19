import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

export function FeedQrCode({ url }: { url: string }) {
  const [image, setImage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(url, { width: 320, margin: 4, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } })
      .then(value => { if (!cancelled) setImage(value); })
      .catch(() => { if (!cancelled) setError('The QR code could not be created. You can copy the feed URL instead.'); });
    return () => { cancelled = true; };
  }, [url]);
  return <div className="feed-qr-code">{image ? <><img src={image} alt="Feed URL QR code" width={320} height={320} /><p className="fine">Scan to open your custom feed URL on another device.</p></> : error ? <p className="error" role="alert">{error}</p> : <p role="status">Creating QR code…</p>}</div>;
}
