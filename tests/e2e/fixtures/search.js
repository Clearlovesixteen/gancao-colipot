const form = document.querySelector('#search-form');
const input = document.querySelector('#search-input');
const results = document.querySelector('#b_results');
const params = new URLSearchParams(location.search);
const renderDelay = Math.max(0, Number(params.get('delay') || 0));
const targetDelay = Math.max(0, Number(params.get('targetDelay') || 0));

function renderResults(query) {
  document.title = `${query} - 通用搜索`;
  history.replaceState({}, '', `?q=${encodeURIComponent(query)}`);
  results.innerHTML = Array.from({ length: 5 }, (_, index) => `
    <li class="b_algo">
      <h2>
        <a
          href="/search-result.html?index=${index + 1}&q=${encodeURIComponent(query)}&loadDelay=${targetDelay}"
          target="_blank"
          rel="noopener noreferrer"
        >${query} 搜索结果 ${index + 1}</a>
      </h2>
      <p>这是第 ${index + 1} 条自然搜索结果。</p>
    </li>
  `).join('');
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const query = input.value.trim();
  if (query) window.setTimeout(() => renderResults(query), renderDelay);
});

const initialQuery = params.get('q');
if (initialQuery) {
  input.value = initialQuery;
  renderResults(initialQuery);
}
