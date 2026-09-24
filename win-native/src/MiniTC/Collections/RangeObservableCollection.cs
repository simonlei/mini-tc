using System.Collections.ObjectModel;
using System.Collections.Specialized;

namespace MiniTC.Collections;

/// <summary>
/// An <see cref="ObservableCollection{T}"/> that can be refilled with a single
/// Reset notification. Adding a 20k-entry directory one item at a time would
/// raise 20k CollectionChanged events and re-layout the list each time; this
/// keeps directory switching at one layout pass.
/// </summary>
public sealed class RangeObservableCollection<T> : ObservableCollection<T>
{
    private bool _suppressNotification;

    protected override void OnCollectionChanged(NotifyCollectionChangedEventArgs e)
    {
        if (!_suppressNotification)
        {
            base.OnCollectionChanged(e);
        }
    }

    internal void ReplaceAll(IEnumerable<T> items)
    {
        _suppressNotification = true;

        try
        {
            Items.Clear();

            foreach (var item in items)
            {
                Items.Add(item);
            }
        }
        finally
        {
            _suppressNotification = false;
        }

        OnPropertyChanged(new System.ComponentModel.PropertyChangedEventArgs(nameof(Count)));
        OnPropertyChanged(new System.ComponentModel.PropertyChangedEventArgs("Item[]"));
        OnCollectionChanged(new NotifyCollectionChangedEventArgs(NotifyCollectionChangedAction.Reset));
    }
}
