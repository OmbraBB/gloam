// GitHub Pages 프로젝트 페이지에서는 사이트가 /<repo>/ 아래에 놓이므로
// 내부 링크에 base를 붙여야 한다. 커스텀 도메인으로 옮겨 base가 '/'가 되어도
// 아래 함수는 그대로 동작하니 호출부는 손댈 필요가 없다.
const BASE = import.meta.env.BASE_URL;

export function withBase(path: string): string {
	return `${BASE.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
}
