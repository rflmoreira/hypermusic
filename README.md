# HyperMusic Player

Player de música standalone com interface moderna, playlists pré-definidas, busca no YouTube, rádio ao vivo e letras sincronizadas.

## 🎵 Funcionalidades

- **Tela Descobrir** — Carousel de banners, playlists em destaque e playlists do usuário
- **Biblioteca** — Lista de faixas com barra de progresso, importação via CSV
- **Busca YouTube** — Busca manual de faixas e playlists diretamente no YouTube
- **Rádio ao Vivo** — Canais de rádio streaming (Sunshine Live)
- **Controles Completos** — Play/Pause, Next/Prev, Shuffle, Repeat, Volume
- **Capa Expandida** — Exibição de capa com letras sincronizadas
- **Vídeo Oficial** — Reprodução de clipes via YouTube IFrame API
- **Mini Player Bar** — Barra compacta para controle rápido
- **Favoritos** — Playlist fixa "Músicas Favoritas" com persistência local
- **Media Session** — Integração com controles de mídia do sistema (lock screen, headphones)
- **Liquid Glass** — Efeito visual avançado de vidro líquido (SVG displacement + backdrop-filter)
- **Persistência** — Estado, playlists e cache salvos em localStorage/IndexedDB

## 📁 Estrutura do Projeto

```
HyperMusic/
├── assets/
│   ├── images/          # Capas das playlists e ícones
│   │   └── radio/       # Imagens dos canais de rádio
│   └── videos/          # Vídeo de fundo
├── css/
│   └── player.css       # Todos os estilos do player
├── js/
│   ├── player.js        # Core do player (MUSIC_PLAYER)
│   └── playlists.js     # Dados das playlists pré-definidas
├── netlify/
│   └── functions/       # Netlify Functions (backend serverless)
├── index.html           # Página standalone
├── netlify.toml         # Configuração do Netlify
├── README.md            # Esta documentação
└── LICENSE              # Licença MIT
```

## 🚀 Como Usar

### Modo Standalone

Basta abrir o `index.html` no navegador:

```bash
# Opção 1: Abrir diretamente
open index.html

# Opção 2: Servidor local (recomendado para todas as funcionalidades)
npx serve .
# ou
python3 -m http.server 8080
```

> **Nota:** Algumas funcionalidades (busca YouTube, capas via Deezer) requerem backend. As playlists pré-definidas funcionam sem backend.

### Incorporar em Outro Site

1. Copie a pasta do projeto para o seu diretório
2. Adicione os CDNs e o CSS no `<head>`:

```html
<head>
  <!-- Tailwind CSS -->
  <script src="https://cdn.tailwindcss.com"></script>
  
  <!-- Phosphor Icons -->
  <link rel="stylesheet" href="https://unpkg.com/@phosphor-icons/web@2.1.1/src/bold/style.css">
  <link rel="stylesheet" href="https://unpkg.com/@phosphor-icons/web@2.1.1/src/fill/style.css">
  <link rel="stylesheet" href="https://unpkg.com/@phosphor-icons/web@2.1.1/src/regular/style.css">
  
  <!-- Player CSS -->
  <link rel="stylesheet" href="css/player.css">
</head>
```

3. Copie todo o conteúdo HTML do player (de `<!-- Mini Player Bar -->` até `<!-- Audio Players -->`) para o `<body>` da sua página

4. Adicione os scripts antes de `</body>`:

```html
<script src="js/playlists.js"></script>
<script src="js/player.js"></script>
```

5. Abra o player via JavaScript:

```javascript
// Opção 1: Via API pública
HyperMusicPlayer.open();

// Opção 2: Via evento
document.dispatchEvent(new CustomEvent('hypermusic:open'));
```

## ⚙️ API Pública

O player expõe uma API simples via `window.HyperMusicPlayer`:

```javascript
// Abrir o player
HyperMusicPlayer.open();

// Importar playlist via CSV
HyperMusicPlayer.importCSV();

// Obter métricas internas (debug)
const metrics = HyperMusicPlayer.getMetrics();
console.log(metrics);
```

### Acesso Interno (Avançado)

Para controle granular, acesse o módulo interno:

```javascript
const player = HyperMusicPlayer._internal;
player.init();
player.openModal();
```

## 📡 Eventos

O player emite e escuta eventos no `document`:

| Evento | Descrição |
|--------|-----------|
| `hypermusic:open` | Abre o modal do player |

## 🎨 Personalização

### Cores

O player usa as seguintes cores de acento (CSS):

```css
/* Cor principal (laranja) */
--accent: #ff7a1f;
/* Fundos de vidro */
background: rgba(0, 0, 0, 0.22);
```

Para alterar a cor principal, busque e substitua `#ff7a1f` e `rgba(255, 122, 31, ...)` no CSS.

### Playlists

Edite `js/playlists.js` para adicionar/remover playlists pré-definidas:

```javascript
const FEATURED_PLAYLISTS = [
  {
    id: 'minha-playlist',
    name: 'Minha Playlist',
    cover: 'assets/images/minha-capa.png',
    isFeatured: true,
    tracks: [
      { name: 'Nome da Música', artists: [{ name: 'Artista' }] },
      // ... mais faixas
    ]
  }
];
```

### Imagens de Capa

Coloque novas imagens de capa em `assets/images/` e referencie no `playlists.js`.

## 🔧 Backend (Opcional)

Para funcionalidades completas, o player espera os seguintes endpoints:

| Endpoint | Função |
|----------|--------|
| `/audio?v={videoId}` | Extrai URL de áudio de um vídeo do YouTube |
| `/youtube?action=search&q={query}` | Busca no YouTube |
| `/youtube?action=playlist&playlistId={id}` | Obtém faixas de uma playlist do YouTube |
| `/deezer?type={type}&q={query}` | Busca capas e metadados no Deezer |
| `/proxy?url={url}` | Proxy CORS para APIs externas |
| `/search?track_name={name}&artist_name={artist}` | Busca de faixas (4shared) |

> **Sem backend:** O player funciona com playlists pré-definidas. A busca no YouTube e reprodução de áudio requerem backend.

## 📱 Compatibilidade

- Chrome 90+ / Edge 90+
- Safari 15+ / iOS Safari 15+
- Firefox 90+
- Suporte a Media Session API
- Design responsivo (mobile-first)

## 📄 Licença

MIT License — veja [LICENSE](LICENSE) para detalhes.
