export function quoteWindowsArgument(value) {
  if (value && !/[\t "]/u.test(value)) return String(value);
  let quoted = '"';
  let backslashes = 0;
  for (const character of String(value)) {
    if (character === '\\') {
      backslashes += 1;
    } else if (character === '"') {
      quoted += '\\'.repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
    } else {
      quoted += '\\'.repeat(backslashes) + character;
      backslashes = 0;
    }
  }
  return `${quoted}${'\\'.repeat(backslashes * 2)}"`;
}

export function parseWindowsCommandLine(value) {
  const source = String(value ?? '');
  const args = [];
  let index = 0;
  while (index < source.length) {
    while (/[ \t]/.test(source[index] ?? '')) index += 1;
    if (index >= source.length) break;
    let argument = '';
    let inQuotes = false;
    let started = false;
    while (index < source.length) {
      let backslashes = 0;
      while (source[index] === '\\') {
        backslashes += 1;
        index += 1;
      }
      if (backslashes) {
        if (source[index] === '"') {
          argument += '\\'.repeat(Math.floor(backslashes / 2));
          if (backslashes % 2 === 1) {
            argument += '"';
            index += 1;
          } else if (inQuotes && source[index + 1] === '"') {
            argument += '"';
            index += 2;
          } else {
            inQuotes = !inQuotes;
            index += 1;
          }
        } else {
          argument += '\\'.repeat(backslashes);
        }
        started = true;
        continue;
      }
      const character = source[index];
      if (character === '"') {
        if (inQuotes && source[index + 1] === '"') {
          argument += '"';
          index += 2;
        } else {
          inQuotes = !inQuotes;
          index += 1;
        }
        started = true;
      } else if (/[ \t]/.test(character) && !inQuotes) {
        break;
      } else {
        argument += character;
        started = true;
        index += 1;
      }
    }
    if (inQuotes) return null;
    if (started) args.push(argument);
    while (/[ \t]/.test(source[index] ?? '')) index += 1;
  }
  return args;
}
