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

The source takes its pattern from one of two places, and you have to pick one.
Set the `volatile` source option to `v:true` and it reads whatever you type
into ddu, which is what live grep wants. Leave `volatile` off and it reads the
`input` source param instead, which is empty until you set it — and an empty
pattern is shorter than `minInputLength`, so the search returns before it ever
reaches the server. You get no results and no error message.

Live grep. Empty `matchers` leaves the filtering to the server, which has
already done it:

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

A fixed pattern, filtered afterwards by ddu:

```vim
nnoremap <space>/
    \ <Cmd>call ddu#start(#{
    \   sources: [#{ name: 'tgrep' }],
    \   sourceParams: #{
    \     tgrep: #{ input: input('Pattern: ') },
    \   },
    \ })<CR>
```

Source params are set the usual way:

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

## Hidden files

tgrep does not index hidden files and directories, and `tgrep serve` cannot be
told otherwise. It rejects `--hidden` outright, and an index built with
`tgrep index --hidden` does not survive: the server compares the index against
its own walk at startup, the hidden entries are missing from that walk, and it
evicts them as deleted. Passing `--hidden` through `serveArgs` therefore does
not widen the search — it stops the server from starting at all.

So a repository that keeps its files under a hidden directory returns nothing,
without an error. Dotfiles are the usual case: everything lives under
`.config/`, and only the handful of files at the top level is searchable.

Hidden is judged relative to the server root, so pointing the root inside the
hidden directory searches it:

```vim
call ddu#custom#patch_global(#{
    \   sourceOptions: #{
    \     tgrep: #{ path: expand('~/dotfiles/.config') },
    \   },
    \ })
```

The root also decides where `.tgrep/` is written and what is out of reach:
with the root at `~/dotfiles/.config`, the files above it are no longer
searched. (Checked against tgrep 1.0.2.)

## Server lifecycle

The source starts `tgrep serve <root>` on demand and leaves it running after
Vim exits so the next session reuses the warm index. Stop it with
`:DduTgrepStop`.

When `setsid` is available the server gets a process group of its own.
Without it, a signal sent to Vim's process group — Ctrl-C in a terminal Vim,
for one — reaches the server too, and it will not survive Vim.

See `:help ddu-source-tgrep` for every parameter.
