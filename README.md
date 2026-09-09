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

This source works around the limitation automatically.  On init it walks the
root and starts an additional `tgrep serve` for each hidden directory (one that
keeps its files under `.config`, say), so their contents are searched alongside
the rest of the repository.  Dotfiles work out of the box.

Each hidden directory gets its own index outside the repository, under the
platform cache directory (`$XDG_CACHE_HOME`, or `~/.cache` on Unix) in
`ddu-source-tgrep/<encoded-root>/<hidden-dir>`.  Directories named `.git` and
`.tgrep` are skipped, as are directories matching the root's `.gitignore`.
Hidden is judged relative to the server root, so pointing the root inside a
hidden directory via `sourceOptions.path` searches that one directory alone.

`:DduTgrepStop` stops every server for the root, including the hidden ones.
(Checked against tgrep 1.0.2.)

## Server lifecycle

The source starts `tgrep serve <root>` on demand and leaves it running after
Vim exits so the next session reuses the warm index. Stop it with
`:DduTgrepStop`.

When `setsid` is available the server gets a process group of its own.
Without it, a signal sent to Vim's process group — Ctrl-C in a terminal Vim,
for one — reaches the server too, and it will not survive Vim.

See `:help ddu-source-tgrep` for every parameter.
