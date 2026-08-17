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
			// 다크 테마에서도 읽히도록 라이트/다크 두 벌을 함께 내보낸다.
			themes: { light: 'github-light', dark: 'github-dark' },
			wrap: true,
		},
	},
	fonts: [
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
