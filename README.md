# ddu-source-tgrep

[tgrep](https://github.com/microsoft/tgrep) source for [ddu.vim](https://github.com/Shougo/ddu.vim).

tgrep keeps a trigram index in a background server and answers queries over
TCP JSON-RPC, so this source sends one request per keystroke instead of
spawning a process. That makes it suited to live grep.

## Required

### denops.vim

https://github.com/vim-denops/denops.vim

### ddu.vim

https://github.com/Shougo/ddu.vim

### tgrep

https://github.com/microsoft/tgrep

```console
$ cargo install --git https://github.com/microsoft/tgrep tgrep-cli
```

## Configuration

```vim
call ddu#custom#patch_global(#{
    \   sourceParams: #{
    \     tgrep: #{
    \       caseMode: 'smart',
    \       scope: 'all',
    \     },
    \   },
    \ })
```

Live grep:

```vim
command! DduTgrepLive call s:ddu_tgrep_live()
function! s:ddu_tgrep_live() abort
  call ddu#start(#{
        \   sources: [#{
        \     name: 'tgrep',
        \     options: #{ matchers: [], volatile: v:true },
        \   }],
        \   uiParams: #{
        \     ff: #{ ignoreEmpty: v:false, autoResize: v:false },
        \   },
        \ })
endfunction
```

## Server lifecycle

The source starts `tgrep serve <root>` on demand and leaves it running after
Vim exits so the next session reuses the warm index. Stop it with
`:DduTgrepStop`.

When `setsid` is available the server gets a process group of its own.
Without it, a signal sent to Vim's process group — Ctrl-C in a terminal Vim,
for one — reaches the server too, and it will not survive Vim.

See `:help ddu-source-tgrep` for every parameter.
