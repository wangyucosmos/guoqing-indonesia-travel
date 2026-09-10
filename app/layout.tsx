import type {Metadata} from 'next';
import './globals.css';
export const metadata:Metadata={title:'国庆印尼旅游 · 岛屿之间',description:'2026 科莫多、巴厘岛、布罗莫旅行攻略与搭子协作计划'};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="zh-CN"><body>{children}</body></html>}
