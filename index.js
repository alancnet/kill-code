const yargs = require('yargs')
const termkit = require('terminal-kit')
const killWithStyle = require('kill-with-style')
const term = termkit.terminal

const { getProcessTree, cmd } = require('./process-tree')
const { inspect } = require('util')

const PATH = process.env.PATH.split(':').flatMap(p => [
  new RegExp(`^()${p}/`, 'g'),
  new RegExp(`( )${p}/`, 'g'),
  
])
function simplify(command) {
  for (let regexp of PATH) {
    command = command.replace(regexp, (_, x) => x)
  }
  return command
}
function summarize(command) {
  return Array.from(new Set(command.split(' '))).join(' ')
}

function walk(fork, proc) {
  if (proc.id == process.pid) fork.self = true
  fork.commands.push(...proc.children.map(x => x.command).filter(cmd => !cmd.includes('.vscode-server')).map(simplify).filter(x => x != 'bash'))
  for (let child of proc.children) {
    walk(fork, child)
  }
  return fork
}

async function main () {
  const argv = yargs
    .option('view-all', {
      alias: 'v',
      type: 'boolean',
      description: 'View all forks, even empty ones.'
    })
    .option('no-tty', {
      alias: 'T',
      type: 'boolean',
      description: 'Disable TTY.'
    })
    .option('kill', {
      alias: 'k',
      type: 'number',
      description: 'Fork IDs to kill.',
      array: true
    })
    .option('all', {
      alias: 'a',
      type: 'boolean',
      description: 'Select all forks (use -v -a to include all empty forks).'
    })
    .option('debug', {
      alias: 'd',
      type: 'boolean',
      description: 'Output debug info regarding killing process tree.'
    })
    .argv

    const tree = await getProcessTree()
  const forkRegex = /\.vscode-server\/bin\/.*\/node .*bootstrap-fork/
  const forks = tree.filter(x => forkRegex.test(x.command)).map(fork => {
    fork.commands = []
    walk(fork, fork)
    fork.summary = `${fork.id}: (${fork.user}) ${fork.commands.join('; ')}`
    fork.commandSummary = fork.commands.join('; ')
    fork.toString = () => fork.summary
    return fork
  })
  .filter(fork => argv.kill || argv.all || (fork.commands.length && !fork.self))
  .sort((a, b) => a.self ? 1 : b.self ? -1 : a.id - b.id)
  if (!argv['no-tty'] && !argv.kill) {
    term.cyan.bold('Select a vscode-server fork to terminate:\n')
    const response = await term.singleColumnMenu(forks, {exitOnUnexpectedKey: true}).promise
    if (response.submitted) {
      const fork = forks[response.selectedIndex]
      if (response.selectedText.includes(cmd)) {
        term.red.bold('Uh, it looks like that is this fork. Are you sure you want to kill me? ([Y]es / [N]o)\n')
      } else {
        term.yellow.bold('This will kill all these processes:\n')
        console.log(fork.commands.map(c => c.padStart(4)).join('\n'))
        term.yellow.bold('Are you sure you want to proceed? ([Y]es / [N]o)\n')
      }
      const confirmed = await term.yesOrNo().promise
      term('\n')
      if (confirmed) {
        await killFork(fork, {debug: argv.debug})
        term('Done\n')
      }
    }
  } else {
    if (argv.kill) {
      if (argv.kill.length && argv.all) {
        console.error('Do not specify PIDs and --all at the same time.')
        process.exit(1)
      }
      const pidsToKill = argv.all
      ? new Set(forks.map(x => x.id))
      : new Set(argv.kill)

      if (!pidsToKill.size) console.info('Nothing to do')
      for (let fork of forks) {
        if (pidsToKill.has(fork.id)) {
          await killFork(fork, { debug: argv.debug })
        }
      }
    } else {
      for (let fork of forks) {
        console.log(fork.summary)
      }
      console.log()
      console.log('To kill a fork, run kill-code --kill <id>.')
    }
  }
  process.exit(0)
  
}

async function killFork(fork, opts) {
  await new Promise((resolve, reject) => {
    killWithStyle(fork.id, {
      signal: ['SIGINT', 'SIGKILL'],
      retryCount: 2,
      retryInterval: 10000,
      timeout: 21000,
      ...opts
    }, (err, val) => err ? reject(err) : resolve(val))
  })

}

module.exports = { main }