export interface Account {
  number: string;
  type: 'SAVINGS' | 'CHECKING' | 'CD';
  nickname: string;
  balance: string; // display string, like the real thing would render
}

export interface Member {
  id: string;
  name: string;
  ssnLast4: string;
  joined: string;
  accounts: Account[];
}

export const MEMBERS: Record<string, Member> = {
  '12345': {
    id: '12345',
    name: 'SMITH, JOHN A',
    ssnLast4: '4821',
    joined: '03/14/2009',
    accounts: [
      { number: '12345-S01', type: 'SAVINGS', nickname: 'PRIMARY SHARE', balance: '4,250.13' },
      { number: '12345-C01', type: 'CHECKING', nickname: 'FREE CHECKING', balance: '1,102.87' },
    ],
  },
  '23456': {
    id: '23456',
    name: 'GARCIA, MARIA L',
    ssnLast4: '9917',
    joined: '11/02/2015',
    accounts: [
      { number: '23456-S01', type: 'SAVINGS', nickname: 'PRIMARY SHARE', balance: '9,812.55' },
    ],
  },
  '34567': {
    id: '34567',
    name: 'NGUYEN, PETER T',
    ssnLast4: '3308',
    joined: '07/21/2001',
    accounts: [
      { number: '34567-S01', type: 'SAVINGS', nickname: 'PRIMARY SHARE', balance: '150.00' },
      { number: '34567-D01', type: 'CD', nickname: '12MO CERTIFICATE', balance: '25,000.00' },
    ],
  },
};

// In-memory sub-account store so the mutating flow has a visible effect.
export const openedSubAccounts: Array<{ memberId: string; type: string; nickname: string; deposit: string }> = [];
