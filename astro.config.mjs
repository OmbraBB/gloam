// @ts-check

import { unified } from '@astrojs/markdown-remark';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import { defineConfig, fontProviders } from 'astro/config';
import rehypeKatex from 'rehype-katex';
import remarkMath from 'remark-math';

// https://astro.build/config
export default defineConfig({
	// GitHub Pages 프로젝트 페이지(https://ombrabb.github.io/gloam/) 기준 설정.
	// TODO: 커스텀 도메인 연결 시 site를 'https://gloam.dev'로 바꾸고 base 줄을 지운다.
	site: 'https://ombrabb.github.io',
	base: '/gloam',
	integrations: [mdx(), sitemap()],
	markdown: {
		// $...$ / $$...$$ 수식을 KaTeX HTML로 변환한다.
		processor: unified({
			remarkPlugins: [remarkMath],
			rehypePlugins: [rehypeKatex],
		}),
		shikiConfig: {
			// 사이트 팔레트(검보라)와 맞물리는 테마로. 라이트/다크 두 벌을 함께 내보낸다.
			themes: { light: 'rose-pine-dawn', dark: 'rose-pine-moon' },
			wrap: true,
		},
	},
	fonts: [
		{
			// 로고와 픽셀 UI 요소 전용. 본문에는 쓰지 않는다(가독성·한글 글리프 없음).
			// 빌드 시점에 내려받아 자체 호스팅되므로 런타임 외부 요청은 없다.
			provider: fontProviders.google(),
			name: 'Press Start 2P',
			cssVariable: '--font-pixel',
			fallbacks: ['monospace'],
			weights: [400],
			styles: ['normal'],
			subsets: ['latin'],
		},
		{
			provider: fontProviders.local(),
			name: 'Atkinson',
			cssVariable: '--font-atkinson',
			fallbacks: ['sans-serif'],
			options: {
				variants: [
					{
						src: ['./src/assets/fonts/atkinson-regular.woff'],
						weight: 400,
						style: 'normal',
						display: 'swap',
					},
					{
						src: ['./src/assets/fonts/atkinson-bold.woff'],
						weight: 700,
						style: 'normal',
						display: 'swap',
					},
				],
			},
		},
	],
});
