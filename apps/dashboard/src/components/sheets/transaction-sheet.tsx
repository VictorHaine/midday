import { useMediaQuery } from "@/hooks/use-media-query";
import { Drawer, DrawerContent } from "@midday/ui/drawer";
import { Sheet, SheetContent } from "@midday/ui/sheet";
import React from "react";
import { TransactionDetails } from "../transaction-details";
import { UpdateTransactionValues } from "@/actions/schema";

type Props = {
  setOpen: (open: boolean) => void;
  isOpen: boolean;
  data: any;
  ids?: string[];
  updateTransaction: (
    values: UpdateTransactionValues,
    optimisticData: any
  ) => void;
};

export function TransactionSheet({
  setOpen,
  isOpen,
  data,
  ids,
  updateTransaction,
}: Props) {
  const isDesktop = useMediaQuery("(min-width: 768px)");

  if (isDesktop) {
    return (
      <Sheet open={isOpen} onOpenChange={setOpen}>
        <SheetContent>
          <TransactionDetails
            data={data}
            ids={ids}
            updateTransaction={updateTransaction}
          />
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Drawer
      open={isOpen}
      onOpenChange={(open: boolean) => {
        if (!open) {
          setOpen(false);
        }
      }}
    >
      <DrawerContent className="p-6">
        <TransactionDetails
          data={data}
          ids={ids}
          updateTransaction={updateTransaction}
        />
      </DrawerContent>
    </Drawer>
  );
}
