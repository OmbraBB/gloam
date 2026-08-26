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
			// 사이트 팔레트(남색 배경 + 초록·보라)와 맞물리는 테마로.
			// night-owl은 남색 바탕에 초록·보라 계열 구문색을 써서 그대로 이어진다.
			themes: { light: 'night-owl-light', dark: 'night-owl' },
			wrap: true,
		},
	},
	fonts: [
		{
			// 라틴 본문·제목용. 한글은 스택 뒤의 Pretendard/시스템 폰트로 떨어진다.
			// 빌드 시점에 내려받아 자체 호스팅되므로 런타임 외부 요청은 없다.
			//
			// VT323(픽셀) + Atkinson 체제에서 Inter 단일 체제로 교체.
			// 유리 패널·그리드 배경의 계기판 무드에는 픽셀보다
			// 타이트한 산세리프 워드마크가 맞는다.
			provider: fontProviders.google(),
			name: 'Inter',
			cssVariable: '--font-sans',
			fallbacks: ['sans-serif'],
			weights: [400, 700, 800, 900],
			styles: ['normal'],
			subsets: ['latin'],
		},
	],
});
