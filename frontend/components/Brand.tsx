import Link from "next/link";
import { ScanLine } from "lucide-react";
export default function Brand() {
  return (
    <Link href="/" className="brand" aria-label="CiteVerify-X home">
      <span className="brand-mark">
        <ScanLine size={21} strokeWidth={1.5} />
      </span>
      <span>
        CiteVerify<span className="brand-x">-X</span>
      </span>
    </Link>
  );
}
