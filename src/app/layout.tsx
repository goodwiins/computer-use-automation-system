import type { Metadata } from 'next';
import '../server/ui/style.css';

export const metadata: Metadata = { title: 'Meridian · Assistant', description: 'Your banking workspace.' };
export default function Layout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body><div id="root">{children}</div></body></html>;
}
